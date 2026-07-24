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

/**
 * Ask the LLM to plan a response + tool calls for the merchant's message.
 * Returns structured JSON. Degrades to a deterministic plan if no key is set.
 */
export async function askLlm(
  messages: LlmMessage[],
  toolCatalog: unknown[],
  shopDomain: string,
): Promise<LlmResult> {
  const c = getClient();
  if (!c) {
    return { ...demoPlan(messages[messages.length - 1]?.content ?? ""), provider: "demo" };
  }

  const model = process.env.NVIDIA_MODEL ?? "meta/llama-3.1-70b-instruct";
  const systemPrompt = [
    `You are Reeve AI, an inventory operations agent embedded in the Shopify store "${shopDomain}".`,
    "You diagnose inventory issues and act through tools. Every action is audited.",
    "",
    "Available tools:",
    JSON.stringify(toolCatalog, null, 2),
    "",
    "Respond with STRICT JSON only, of the shape:",
    '{"reasoning":"<one short paragraph for the merchant>","toolCalls":[{"name":"<tool>","args":{...}}]}',
    "Do not wrap the JSON in markdown fences. Pick only from the listed tools.",
  ].join("\n");

  try {
    const completion = await c.chat.completions.create({
      model,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      temperature: 0.3,
      max_tokens: 800,
    });
    const content = completion.choices[0]?.message?.content ?? "";
    return { ...parseLlmJson(content, messages[messages.length - 1]?.content ?? ""), provider: "nvidia" };
  } catch (e) {
    console.error("[llm] NVIDIA call failed, falling back to demo:", e);
    return { ...demoPlan(messages[messages.length - 1]?.content ?? ""), provider: "demo" };
  }
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
