// ────────────────────────────────────────────────────────────────────────────
// app/lib/llm.server.ts — NVIDIA LLM provider (OpenAI-compatible endpoint).
//
// NVIDIA build.nvidia.com exposes an OpenAI-compatible /v1 endpoint for open
// models (GLM, Llama, Qwen). We use the `openai` SDK pointed at NVIDIA's base
// URL — no NVIDIA-specific SDK needed. The agent calls chat() with a system
// prompt + a JSON tool-calling instruction; the model returns structured JSON
// we parse into tool calls.
//
// Falls back to a deterministic demo plan if NVIDIA_API_KEY is unset, so the
// app always works (important for demos/judges who don't have a key configured).
// ────────────────────────────────────────────────────────────────────────────

import OpenAI from "openai";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface LlmResult {
  /** Natural-language reasoning shown to the merchant. */
  reasoning: string;
  /** Ordered tool calls the model decided on. */
  toolCalls: LlmToolCall[];
  /** Which provider actually answered. */
  provider: "nvidia" | "demo";
}

export type ReasoningEffort = "medium" | "high" | "max";

let client: OpenAI | null = null;

function getClient(): OpenAI | null {
  if (!process.env.NVIDIA_API_KEY) return null;
  if (client) return client;
  client = new OpenAI({
    apiKey: process.env.NVIDIA_API_KEY,
    baseURL: process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
  });
  return client;
}

/** Map UI effort levels to DeepSeek chat-template kwargs. "max" = highest
 *  thinking + a generous max_tokens ceiling so the final answer has room. */
function effortKwargs(effort: ReasoningEffort) {
  if (effort === "max") return { thinking: true, reasoning_effort: "high" };
  if (effort === "high") return { thinking: true, reasoning_effort: "high" };
  return { thinking: true, reasoning_effort: "medium" };
}

function effortMaxTokens(effort: ReasoningEffort): number {
  if (effort === "max") return 4096;
  if (effort === "high") return 3072;
  return 2048;
}

/**
 * Ask the LLM to plan a response + tool calls for the merchant's message.
 * Returns structured JSON. Degrades to a deterministic plan if no key is set.
 */
export async function askLlm(
  messages: LlmMessage[],
  toolCatalog: unknown[],
  shopDomain: string,
  effort: ReasoningEffort = "medium",
): Promise<LlmResult> {
  const c = getClient();
  if (!c) {
    return { ...demoPlan(messages[messages.length - 1]?.content ?? ""), provider: "demo" };
  }

  const model = process.env.NVIDIA_MODEL ?? "deepseek-ai/deepseek-v4-flash";
  const systemPrompt = [
    `You are Reeve AI, an inventory operations agent embedded in the Shopify store "${shopDomain}".`,
    "You diagnose inventory issues and act through tools. Every action is audited.",
    "",
    "Available tools:",
    JSON.stringify(toolCatalog, null, 2),
    "",
    "Respond with STRICT JSON only, of the shape:",
    '{"reasoning":"<one short paragraph — what you noticed and what you plan to do>","toolCalls":[{"name":"<tool>","args":{...}}]}',
    "Do not wrap the JSON in markdown fences. Pick only from the listed tools.",
    "If no tool is needed (e.g. the user is just asking a conceptual question), use an empty toolCalls array and explain in reasoning.",
  ].join("\n");

  try {
    const completion = await c.chat.completions.create({
      model,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      temperature: 0.3,
      top_p: 0.95,
      max_tokens: effortMaxTokens(effort),
      ...(process.env.NVIDIA_THINKING === "false"
        ? {}
        : { chat_template_kwargs: effortKwargs(effort) }),
    } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
    const content = completion.choices[0]?.message?.content ?? "";
    return { ...parseLlmJson(content, messages[messages.length - 1]?.content ?? ""), provider: "nvidia" };
  } catch (e) {
    console.error("[llm] NVIDIA plan call failed, falling back to demo:", e);
    return { ...demoPlan(messages[messages.length - 1]?.content ?? ""), provider: "demo" };
  }
}

/**
 * Second LLM call: given the user message, the plan reasoning, and the tool
 * execution results, produce a NATURAL-LANGUAGE final answer for the merchant.
 * No tool calls here — this is the polished summary the user reads in the body.
 * Falls back to a synthesized summary if no API key (so demo mode still works).
 */
export async function askLlmAnswer(
  messages: LlmMessage[],
  userMessage: string,
  reasoning: string,
  toolResults: { name: string; summary: string; ok: boolean; error?: string; result: unknown }[],
  shopDomain: string,
  effort: ReasoningEffort = "medium",
): Promise<{ answer: string; provider: "nvidia" | "demo" }> {
  const c = getClient();
  if (!c) {
    return { answer: synthesizeAnswer(userMessage, reasoning, toolResults), provider: "demo" };
  }

  const model = process.env.NVIDIA_MODEL ?? "deepseek-ai/deepseek-v4-flash";
  const systemPrompt = [
    `You are Reeve AI, an inventory operations agent in the Shopify store "${shopDomain}".`,
    "You already planned the work + ran tools. Now produce the FINAL answer for the merchant.",
    "",
    "Rules:",
    "- Be concise and direct. Two or three sentences max unless results demand more.",
    "- Reference what the tools actually returned (counts, names, error messages) — do NOT make up data.",
    "- If tools succeeded, summarize the outcome. If a tool failed, tell the user what went wrong and suggest a next step.",
    "- Do NOT include the action-card summaries (the UI renders those separately). Just the answer prose.",
    "- Plain text only. No markdown, no emoji, no JSON.",
    "",
    "Plan reasoning (your own thinking step):",
    reasoning || "(none)",
    "",
    "Tool execution results:",
    JSON.stringify(toolResults.map((t) => ({ name: t.name, summary: t.summary, ok: t.ok, error: t.error, result: t.result })), null, 2),
  ].join("\n");

  try {
    const completion = await c.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages,
        { role: "user", content: userMessage },
      ],
      temperature: 0.4,
      top_p: 0.95,
      max_tokens: effortMaxTokens(effort),
      ...(process.env.NVIDIA_THINKING === "false"
        ? {}
        : { chat_template_kwargs: { thinking: false } }),
    } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
    const answer = (completion.choices[0]?.message?.content ?? "").trim();
    return { answer: answer || synthesizeAnswer(userMessage, reasoning, toolResults), provider: "nvidia" };
  } catch (e) {
    console.error("[llm] NVIDIA answer call failed, synthesizing summary:", e);
    return { answer: synthesizeAnswer(userMessage, reasoning, toolResults), provider: "demo" };
  }
}

/** Templated fallback for the final-answer step (demo mode or second-call failure). */
function synthesizeAnswer(
  userMessage: string,
  _reasoning: string,
  toolResults: { name: string; summary: string; ok: boolean; error?: string; result: unknown }[],
): string {
  const ok = toolResults.filter((t) => t.ok);
  const failed = toolResults.filter((t) => !t.ok);
  if (!toolResults.length) return "Nothing to act on right now.";
  const parts: string[] = [];
  if (ok.length) parts.push(ok.map((t) => t.summary).join("; ") + ".");
  if (failed.length) parts.push(`${failed.length} action(s) failed: ${failed.map((t) => t.summary).join("; ")}.`);
  return parts.join(" ") || "Done.";
}

/** Parse the model's JSON; fall back to a demo plan if malformed. */
function parseLlmJson(content: string, userMessage: string): Omit<LlmResult, "provider"> {
  try {
    const cleaned = content.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(cleaned) as { reasoning?: string; toolCalls?: LlmToolCall[] };
    return {
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      toolCalls: Array.isArray(parsed.toolCalls) ? parsed.toolCalls.filter((t) => t && typeof t.name === "string") : [],
    };
  } catch {
    return demoPlan(userMessage);
  }
}

// ─── Deterministic fallback (no API key configured) ────────────────────────────

function demoPlan(message: string): Omit<LlmResult, "provider"> {
  const m = message.toLowerCase();

  if (/\b(mark|set).*out of stock|unavailable\b/.test(m)) {
    return {
      reasoning: "I'll find the low and out-of-stock products so we can act on them.",
      toolCalls: [{ name: "get_low_stock_products", args: {} }],
    };
  }
  if (/\b(restock|reorder|replenish)\b/.test(m)) {
    return {
      reasoning: "Let me pull the low-stock list so we can plan a restock.",
      toolCalls: [{ name: "get_low_stock_products", args: {} }],
    };
  }
  if (/\b(summary|summarize|overview|health|status|report)\b/.test(m)) {
    return {
      reasoning: "Here's a quick health snapshot of your inventory.",
      toolCalls: [{ name: "summarize_inventory", args: {} }],
    };
  }
  // default: what's running low
  return {
    reasoning: "Let me check what's running low so you can act on it.",
    toolCalls: [{ name: "get_low_stock_products", args: {} }],
  };
}
