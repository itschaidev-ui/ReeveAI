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
  /** "execute" = run immediately (read-only tools); "propose" = route to an
   *  Approve card on the client; the merchant must approve before the write
   *  actually runs. Defaults to "execute" when the model omits it. */
  disposition?: "execute" | "propose";
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
    "Tools are split into two kinds:",
    "- READ tools (get_products, get_low_stock_products, get_locations, summarize_inventory). You may call these any time. They run immediately and just inform the merchant.",
    "- WRITE tools (update_inventory, set_product_status, update_price). These mutate the merchant Shopify store. You PROPOSE them but DO NOT execute them yourself -- the merchant will see an Approve card and must click Approve before the write actually runs.",
    "- For each write tool you emit, set \"disposition\":\"propose\" on the toolCalls entry. For read tools, set \"disposition\":\"execute\" (or omit it).",
    "- You can only call a write tool if you already know the required ids (productId, variantId, locationId) from current chat history or from a tool call earlier in this same turn. If you do not have the ids, FIRST call the appropriate read tool to get them, then tell the merchant you will propose the write once they ask again.",
    "",
    "Respond with STRICT JSON only, of the shape:",
    '{"reasoning":"<numbered reasoning steps>","toolCalls":[{"name":"<tool>","args":{...},"disposition":"execute|propose"}]}',
    "",
    "Reasoning format:",
    '- "reasoning" is a multi-line string where each line is one numbered step of your thought process.',
    '- Each line starts with "N. <Step Name> - <short explanation>" (e.g. "1. Analyze Input - parsing the merchant question").',
    "- Include the steps: Analyze Input, Identify Intent, Determine Response, Plan Tool Calls (if any).",
    "- Typically 2-5 steps. Be terse -- one short clause per step.",
    "",
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
    '- If the user asked for something outside your tool scope (e.g. physically shipping items, billing, marketing, refunds), say so honestly and guide them to the right place in Shopify admin (e.g. Settings > Billing, Orders > Refunds, etc). Never silently fail — escalate.',
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
    const toolCalls: LlmToolCall[] = (Array.isArray(parsed.toolCalls) ? parsed.toolCalls : [])
      .filter((t) => t && typeof t.name === "string")
      .map((t) => ({
        name: t.name,
        args: t.args && typeof t.args === "object" ? (t.args as Record<string, unknown>) : {},
        // Coerce: only strictly "propose" stays; everything else falls back to execute.
        disposition: t.disposition === "propose" ? ("propose" as const) : ("execute" as const),
      }));
    return {
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      toolCalls,
    };
  } catch {
    return demoPlan(userMessage);
  }
}

// ─── Deterministic fallback (no API key configured) ────────────────────────────

function demoPlan(message: string): Omit<LlmResult, "provider"> {
  const m = message.toLowerCase();
  const num = (lines: string[]) => lines.map((l, i) => `${i + 1}. ${l}`).join("\n");

  // Special demo branch: explicitly show the approve-card flow with a
  // clearly-labeled placeholder product. Lets demo users see the gate work
  // even when no NVIDIA key is configured.
  if (/\b(demo|preview|show).*(approve|approval|gate|write)\b/.test(m)) {
    return {
      reasoning: num([
        "Analyze Input — demo request to preview the write-approval flow.",
        "Identify Intent — surface a proposed DRAFT write so the merchant can see the Approve card.",
        "Determine Response — emit a single set_product_status propose call with a placeholder id.",
        "Plan Tool Calls — propose set_product_status (disposition: propose).",
      ]),
      toolCalls: [{
        name: "set_product_status",
        args: { productId: "gid://shopify/Product/DEMO-PLACEHOLDER", status: "DRAFT" },
        disposition: "propose",
      }],
    };
  }

  if (/\b(mark|set).*out of stock|unavailable\b/.test(m)) {
    return {
      reasoning: num([
        "Analyze Input — the merchant wants out-of-stock items marked unavailable.",
        "Identify Intent — change product availability on Shopify.",
        "Determine Response — fetch low + out-of-stock products, then flip them to DRAFT.",
        "Plan Tool Calls — call get_low_stock_products to find the affected SKUs.",
      ]),
      toolCalls: [{ name: "get_low_stock_products", args: {} }],
    };
  }
  if (/\b(restock|reorder|replenish)\b/.test(m)) {
    return {
      reasoning: num([
        "Analyze Input — the merchant wants to plan a restock.",
        "Identify Intent — surface what needs reordering.",
        "Determine Response — pull the current low-stock list.",
        "Plan Tool Calls — call get_low_stock_products to find the candidates.",
      ]),
      toolCalls: [{ name: "get_low_stock_products", args: {} }],
    };
  }
  if (/\b(summary|summarize|overview|health|status|report)\b/.test(m)) {
    return {
      reasoning: num([
        "Analyze Input — the merchant wants an overall inventory health report.",
        "Identify Intent — summarize stock counts across the store.",
        "Determine Response — compute totals: in-stock, low, out-of-stock.",
        "Plan Tool Calls — call summarize_inventory.",
      ]),
      toolCalls: [{ name: "summarize_inventory", args: {} }],
    };
  }
  // default: what's running low
  return {
    reasoning: num([
      "Analyze Input — the merchant is asking about inventory state.",
      "Identify Intent — surface what is running low.",
      "Determine Response — fetch products at or below the low-stock threshold.",
      "Plan Tool Calls — call get_low_stock_products.",
    ]),
    toolCalls: [{ name: "get_low_stock_products", args: {} }],
  };
}
