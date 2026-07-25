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
    "You diagnose inventory issues AND you act on them. You have READ tools and WRITE tools. Use them.",
    "Every action is audited.",
    "",
    "Available tools:",
    JSON.stringify(toolCatalog, null, 2),
    "",
    "CRITICAL — DO NOT REFUSE by claiming you lack capabilities. If a tool is in the catalog above, you HAVE that capability. Specifically:",
    "- You CAN change product availability via set_product_status (set status to DRAFT to make a product unavailable).",
    "- You CAN change a price via update_price.",
    "- You CAN restock via update_inventory (needs a locationId from get_locations).",
    "- Never write text like 'I can only read' or 'I do not have tools to change X' — those are FALSE. The tools are in your catalog.",
    "",
    "Two dispositions for toolCalls:",
    '- "execute" — for READ tools (get_products, get_low_stock_products, get_locations, summarize_inventory). These run immediately.',
    '- "propose" — for WRITE tools (set_product_status, update_inventory, update_price). You MUST emit these with disposition:"propose" when the merchant asks for that change. They will NOT run automatically — the merchant sees an Approve card and clicks Approve. Proposing a write IS your job; you do not need permission to propose, you only need it to execute.',
    "",
    "Required ids:",
    "- Write tools need ids (productId, variantId, locationId) you learned from a prior READ tool call (in this turn or earlier in chat history).",
    "- If the merchant asks for a write and you do NOT yet have the required ids, FIRST emit the matching read tool (disposition:execute) to fetch them. Then, in the SAME toolCalls batch, also emit the write tool (disposition:propose) using the ids you expect to find — the agent loop auto-fills single-row results into the next call's missing ids.",
    "- Only say 'I will need you to ask again' if you genuinely cannot get the ids from any available read tool.",
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
    '- BUT: never claim you lack a capability that is in your tool catalog (set_product_status, update_price, update_inventory). When the merchant asks for a product status change, price change, or inventory restock, your answer should describe the proposed action or its result, not refuse. If no proposed-write card was generated this turn, tell the merchant to ask again with a specific product so you can propose the write.',
    "- PENDING WRITES DID NOT HAPPEN YET. If the input mentions '[PROPOSED WRITES — awaiting merchant approval]', those writes have NOT run. Phrase them in future tense or as proposals: 'I have proposed marking <product> as DRAFT — approve below to apply it.' Never say 'I marked', 'I updated', or 'I changed' for a pending write. Only use past tense for actions whose results are listed in the tool execution results section.",
    "- ABSOLUTE RULE: if the input contains [WRITE GATE STATUS]: No writes were proposed or executed this turn, you MUST NOT use any phrase that claims a write happened. Do not say I have proposed, I set, I marked, I updated, I changed, I applied, or I restocked. Instead, tell the merchant you can show them the data but need them to name a specific product (and target value) before you can propose a write.",
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

  // ── Product status change (the most-requested write). Matches a wide band
  //    of natural phrasings so the Approve card is actually reachable from
  //    demo mode. Direction is decided by which keywords the merchant used.
  //
  //    DRAFT (unavailable) intent: out of stock, unavailable, discontinue,
  //      archive, unpublish, hide, draft, inactive, make unavailable.
  //    ACTIVE (available) intent: active, available, publish, list, reinstate,
  //      restore, make available, bring back, relist.
  //
  //    Order matters: an explicit ACTIVE keyword wins even if "draft" appears
  //    elsewhere in the sentence (e.g. "make the draft snowboard active").
  const draftKws = /\b(out of stock|unavailable|discontinue|discontinued|archive|archived|unpublish|unpublished|hide|hidden|draft|inactive|deactivate)\b/;
  const activeKws = /\b(active|activate|available|publish|published|list|listed|reinstate|restore|bring back|relist|relaunch)\b/;
  const statusVerbKws = /\b(mark|set|make|put|switch|change|update|turn|go)\b/;
  const statusTrigger = /\b(active|activate|available|draft|unavailable|out of stock|discontinue|archive|unpublish|hide|inactive|deactivate|publish|reinstate|restore|relist|relaunch)\b/;
  if (statusTrigger.test(m) && (activeKws.test(m) || draftKws.test(m))) {
    // Resolve direction: explicit ACTIVE beats DRAFT unless the merchant named
    // a draft-state product AND used a make-active verb ("make the draft
    // snowboard active" → ACTIVE; "mark this out of stock" → DRAFT).
    const wantsActive = activeKws.test(m);
    const targetStatus = wantsActive ? "ACTIVE" : "DRAFT";
    // If the merchant named a specific product, search for it so the agent
    // loop can auto-fill the productId. Otherwise fall back to the low-stock
    // read (broad "mark all out of stock" style) and let auto-fill target it.
    const hasSpecific = /\b(snowboard|shirt|shirt|coffee|mug|t-shirt|tshirt|tee|hat|cap|beanie|jacket|bag|book|mug|bottle|sticker|poster|print)\b/.test(m) ||
      /\b(product|item|variant)\b/.test(m);
    const reasoningLines = [
      `Analyze Input - the merchant wants a product status change to ${targetStatus}.`,
      `Identify Intent - set_product_status (a WRITE tool, disposition: propose). ${hasSpecific ? "A specific product was named, so search for it first." : "No specific product named, so pull the low-stock list as the target candidate."}`,
      "Determine Response - fetch the target product(s) (read), then propose the status change. The agent loop auto-fills the productId from the read result.",
      `Plan Tool Calls - get the product (execute) + set_product_status with status ${targetStatus} (propose).`,
    ];
    const toolCalls = hasSpecific
      ? [
          { name: "get_products", args: {} },
          { name: "set_product_status", args: { status: targetStatus }, disposition: "propose" as const },
        ]
      : [
          { name: "get_low_stock_products", args: {} },
          { name: "set_product_status", args: { status: targetStatus }, disposition: "propose" as const },
        ];
    return {
      reasoning: num(reasoningLines),
      toolCalls,
    };
  }
  // Status-change intent that mentions the verb but our keyword set didn't
  // catch a direction (e.g. "make X live"). Treat as ACTIVE by default so the
  // approve flow still surfaces.
  if (statusVerbKws.test(m) && /\b(live|visible|on|off|sale|selling)\b/.test(m)) {
    return {
      reasoning: num([
        "Analyze Input - the merchant wants a product visibility/status change.",
        "Identify Intent - set_product_status (WRITE, propose).",
        "Determine Response - fetch the product, then propose the change.",
        "Plan Tool Calls - get_products (execute) + set_product_status ACTIVE (propose).",
      ]),
      toolCalls: [
        { name: "get_products", args: {} },
        { name: "set_product_status", args: { status: "ACTIVE" }, disposition: "propose" },
      ],
    };
  }
  // Price change (WRITE). Catches "change the price to $20", "set X to 9.99",
  // "make it $15", "raise/lower/drop the price", etc. Extracts a numeric value
  // so the proposal summary shows the actual target price.
  const priceMatch = m.match(/\$\s?(\d+(?:\.\d{1,2})?)|to\s+(\d+(?:\.\d{1,2})?)|price.*?(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*(?:dollars|usd|bucks)/);
  const priceVerb = /\b(price|priced|cost|costs|charge|charging|mark up|mark down|discount|raise|lower|drop|increase|decrease|change|set|update)\b/;
  if (priceVerb.test(m) && priceMatch) {
    const priceStr = (priceMatch.slice(1).find(Boolean) ?? "0").trim();
    return {
      reasoning: num([
        "Analyze Input - the merchant wants to change a product price.",
        "Identify Intent - update_price (a WRITE tool, disposition: propose).",
        "Determine Response - fetch the target product (read), then propose the price change. The agent loop auto-fills the variantId from the read result.",
        `Plan Tool Calls - get_products (execute) + update_price to ${priceStr} (propose).`,
      ]),
      toolCalls: [
        { name: "get_products", args: {} },
        // variantId is intentionally omitted — resolveWriteArgs fills it from
        // the get_products result above. price must be a string per the schema.
        { name: "update_price", args: { price: priceStr }, disposition: "propose" },
      ],
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
