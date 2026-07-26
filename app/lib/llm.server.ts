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
    "- If the merchant asks for a write and you do NOT yet have the required ids, FIRST emit the matching read tool (disposition:execute) to fetch them. Then, in the SAME toolCalls batch, also emit the write tool (disposition:propose) — OMIT the id field entirely (do not set it). The agent loop auto-fills it from the read result, and if the read returns multiple rows it expands the single write into one Approve card PER matched product.",
    "- NEVER put placeholder values like 'PLACEHOLDER', 'DEMO', 'TODO', 'null', or a bare number in an id field. Either omit the field (preferred — the loop fills it) or use a real gid://shopify/... id from history. Placeholders cause hard GraphQL failures on Approve.",
    "- Only say 'I will need you to ask again' if you genuinely cannot get the ids from any available read tool.",
    "",
    "PROACTIVE SEARCH — mandatory behavior:",
    "- When the merchant references a SET of products by status or condition ('mark archived items as draft', 'set out-of-stock to unavailable', 'fix the draft products'), do NOT ask them to name the products. Search for the set yourself in the same turn using get_products with a status: query.",
    "- get_products' `query` arg supports Shopify search syntax: 'status:archived', 'status:draft', 'status:active', or a title like 'snowboard'. Use the most specific filter that matches what the merchant described.",
    "- After the read returns, propose the write (or one write per matched product via auto-expand) in the SAME turn. The merchant should never have to ask twice for something you could have done in turn one.",
    "- Round-trips are friction. One user message → one search → one set of proposals is the goal.",
    "",
    "CHARTS / DATA VISUALIZATION — when the merchant asks to SEE data ('show me...', 'chart...', 'graph...', 'visualize...', 'breakdown of...', 'over time', 'how are sales going', 'what are my top...', 'who are my best customers', 'which discounts are used most', 'how many new customers'), pick a chart_* tool to render the data, NOT a get_* tool:",
    "- 'show sales / revenue / orders over time' or 'how am I doing recently' → chart_sales_over_time(days=30). days optional, default 30.",
    "- 'what are my best sellers / top products / most-sold items' → chart_top_products_by_units(days=30, limit=10).",
    "- 'revenue by product_type / vendor' or 'sales by X' (categorical split) → chart_revenue_by_dimension(dimension='product_type', days=30). dimension required, one of: product_type, vendor, status, fulfillment_status.",
    "- 'inventory health / catalog breakdown / how are products distributed / what is my catalog' → chart_inventory_distribution(dimension='status'). dimension required, one of: status, product_type, vendor, stock_health.",
    "- 'new customers / customer growth / signups over time' → chart_new_customers_over_time(days=90).",
    "- 'best discounts / most-used codes / coupon performance' → chart_top_discounts_by_usage(limit=8).",
    "- When you call a chart_* tool, the chat UI renders a chart card below your answer. You DON'T need to draw the chart — the card does. Just summarize the key finding in your answer prose (e.g. 'Sales totaled $42K over the last 30 days, with a slow week around the 14th — see the chart below.').",
    "- chart_* tools are READs: disposition='execute'. They run immediately. Never propose them.",
    "- If the merchant asks for both a chart AND a fix ('show me low-stock products and restock them'), emit BOTH tools in the same toolCalls batch: the chart_ tool AND the read+write sequence. One turn.",
    "- Don't call a chart_* tool when the merchant wants a specific lookup ('do we have the blue snowboard?', 'find product B'). Use get_products for those — they return a text list, which is what the merchant actually wants.",
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
    "- BATCH PROPOSALS: if the PROPOSED WRITES list contains more than one entry for the same kind of action (e.g. 3 set_product_status calls for 3 archived products), say so explicitly and concisely: 'I found 3 archived products — I've proposed marking all 3 as DRAFT. Approve each below.' Do not list every product name in the prose if the action cards already show them.",
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

  // ── Chart / visualization routing (chart_* tools). Mirror the chart routing
  //    block in the live planner prompt so demo mode renders charts too.
  //    Ordering rules (so we disambiguate "revenue by product type" from
  //    "inventory by product type" and don't trip on bare "status"):
  //      1. Inventory/catalog/stock keyword + a "by <dim>" or "distributed"
  //         signal, AND no revenue/sales/orders keyword → chart_inventory_distribution.
  //      2. "revenue|sales|orders by <dim>" or "breakdown by <dim>" with a real
  //         dimension word → chart_revenue_by_dimension (beats sales-over-time).
  //      3. Sales keyword + a time/trend signal → chart_sales_over_time.
  //      4. Top/best-products phrasing → chart_top_products_by_units.
  //      5. New-customer phrasing → chart_new_customers_over_time.
  //      6. Discount usage phrasing → chart_top_discounts_by_usage.
  //      7. Fall-through default → chart_inventory_distribution (status).
  const isChartAsk =
    /\b(chart|graph|visualize|visualise|plot|breakdown|distribution|distributed|over time|trend|trending|recently|lately)\b/i.test(m)
    || /\bshow(me)?\b/i.test(m)
    || /\b(how (are|is) .+ (going|doing|trending))\b/i.test(m)
    || /\b(top|best|most.?sold|popular|best.?seller|bestseller)\s/i.test(m)
    || /\b(revenue|sales|orders?)\s+by\b/i.test(m)
    || /\bby\s+(product.?type|vendor|fulfillment\s?status)\b/i.test(m)
    || (/\bhow many\b/i.test(m) && /\b(customer|customers|signups?|sign.?ups?)\b/i.test(m))
    || (/\b(best|top|most.?used|which)\b/i.test(m) && /\b(discount|coupon|code|promo)\b/i.test(m));
  if (isChartAsk) {
    const hasRevenueKw = /\b(revenue|sales|orders?|income|gross|net|gmv)\b/i.test(m);
    // Inventory keyword — the BLUNT inventory words only (inventory/catalog/stock),
    // NOT bare "product" so "revenue by product type" doesn't trap here.
    const bluntInvKw = /\b(inventory|catalog(ue)?|stock)\b/i.test(m);
    const invBySubj = /\b(how (is|are) .+ (inventory|catalog(ue)?|stock))\b/i.test(m);
    if ((bluntInvKw || invBySubj) && !hasRevenueKw) {
      const hasByDim = /\bby\s+(product.?type|vendor|stock.?health|status)\b/i.test(m) || /\b(distributed|distribution|breakdown|overview)\b/i.test(m);
      if (hasByDim || invBySubj) {
        let dim = "status";
        if (/product.?type/i.test(m)) dim = "product_type";
        else if (/\bvendor\b/i.test(m)) dim = "vendor";
        else if (/health/i.test(m)) dim = "stock_health";
        else if (/\bstatus\b/i.test(m)) dim = "status";
        return {
          reasoning: num([
            `Analyze Input \u2014 the merchant wants a catalog/inventory breakdown by ${dim}.`,
            `Identify Intent \u2014 chart_inventory_distribution (READ, donut by ${dim}).`,
            `Determine Response \u2014 render the donut from the current catalog snapshot.`,
            `Plan Tool Calls \u2014 chart_inventory_distribution(dimension="${dim}").`,
          ]),
          toolCalls: [{ name: "chart_inventory_distribution", args: { dimension: dim } }],
        };
      }
    }
    // REVENUE BY DIMENSION — beats sales-over-time when a "by <dim>" pattern is
    // present (a dimension split is not a time series). Catches plain
    // "revenue by product_type" with no time window too.
    const byDimRevenue = /\b(revenue|sales|orders?)\s+by\b/i.test(m) || /\bbreakdown\s+by\b/i.test(m);
    const dimWord = /\b(product.?type|vendor|fulfillment\s?status)\b/i.test(m) || /\bby\s+status\b/i.test(m);
    if ((byDimRevenue && dimWord) || byDimRevenue) {
      let dim = "product_type";
      if (/product.?type/i.test(m)) dim = "product_type";
      else if (/\bvendor\b/i.test(m)) dim = "vendor";
      else if (/fulfillment/i.test(m)) dim = "fulfillment_status";
      else if (/\bstatus\b/i.test(m)) dim = "status";
      const days = m.match(/\b(?:last|past|over the)\s+(\d+)\s*(?:d|day|days)\b/i);
      const dN = days ? Number(days[1]) : 30;
      return {
        reasoning: num([
          `Analyze Input \u2014 the merchant wants revenue split by ${dim}.`,
          `Identify Intent \u2014 chart_revenue_by_dimension (READ, donut by ${dim}).`,
          `Determine Response \u2014 render the donut over the last ${dN} days.`,
          `Plan Tool Calls \u2014 chart_revenue_by_dimension(dimension="${dim}", days=${dN}).`,
        ]),
        toolCalls: [{ name: "chart_revenue_by_dimension", args: { dimension: dim, days: dN } }],
      };
    }
    // SALES OVER TIME
    const salesKw = hasRevenueKw;
    const tenseKw =
      /\b(over time|trend|trending|recently|lately|how (am|is) (i|it|sales|revenue|it going))\b/i.test(m)
      || /\b(?:over the |over |last |past )\s?\d+\s*(?:d|day|days|w|wk|week|weeks|m|mo|month|months)\b/i.test(m)
      || /\bgoing\b/i.test(m);
    if (salesKw && tenseKw) {
      const days = m.match(/\b(?:last|past|over the)\s+(\d+)\s*(?:d|day|days)\b/i);
      const dN = days ? Number(days[1]) : 30;
      return {
        reasoning: num([
          "Analyze Input \u2014 the merchant wants a sales-over-time trend.",
          "Identify Intent \u2014 chart_sales_over_time (READ, daily net sales: gross minus refunds).",
          `Determine Response \u2014 render the area chart over the last ${dN} days.`,
          `Plan Tool Calls \u2014 chart_sales_over_time(days=${dN}).`,
        ]),
        toolCalls: [{ name: "chart_sales_over_time", args: { days: dN } }],
      };
    }
    // TOP PRODUCTS BY UNITS SOLD
    if (/\b(best|top|most.?sold|best.?sell(ing|ers?)?|popular|popular items|best sellers?)\b/i.test(m)
        && /\b(product|sellers?|items?|selling|sold)\b/i.test(m)) {
      const days = m.match(/\b(?:last|past|over the|this)\s+(\d+)\s*(d|day|days|w|wk|week|weeks|m|mo|month|months)\b/i);
      let dayN = 30;
      if (days) {
        const n = Number(days[1]);
        if (/^(w|wk|week|weeks)$/.test(days[2])) dayN = n * 7;
        else if (/^(m|mo|month|months)$/.test(days[2])) dayN = n * 30;
        else dayN = n;
      }
      return {
        reasoning: num([
          "Analyze Input \u2014 the merchant wants a ranking of best-selling products.",
          "Identify Intent \u2014 chart_top_products_by_units (READ, horizontal bar by units sold).",
          `Determine Response \u2014 render the bar chart over the last ${dayN} days, top 10.`,
          `Plan Tool Calls \u2014 chart_top_products_by_units(days=${dayN}).`,
        ]),
        toolCalls: [{ name: "chart_top_products_by_units", args: { days: dayN, limit: 10 } }],
      };
    }
    // NEW CUSTOMERS OVER TIME
    if (/\b(new customers?|customer (growth|signups?|sign.?ups?)|customers? over time)\b/i.test(m) || (/\bhow many\b/i.test(m) && /\b(customer|signups?)\b/i.test(m))) {
      const days = m.match(/\b(?:last|past|over the)\s+(\d+)\s*(?:d|day|days)\b/i);
      const dN = days ? Number(days[1]) : 90;
      return {
        reasoning: num([
          "Analyze Input \u2014 the merchant wants new-customer growth over time.",
          "Identify Intent \u2014 chart_new_customers_over_time (READ, line per day/week).",
          `Determine Response \u2014 render the line chart over the last ${dN} days.`,
          `Plan Tool Calls \u2014 chart_new_customers_over_time(days=${dN}).`,
        ]),
        toolCalls: [{ name: "chart_new_customers_over_time", args: { days: dN } }],
      };
    }
    // TOP DISCOUNTS BY USAGE
    if (/\b(discount|coupon|promo(s|otions?)?|code)\s+(performance|used|usage|work)|best (discounts?|coupons?)|most.used (discounts?|codes?|coupons?)|which (discounts?|codes?|coupons?)/i.test(m)) {
      return {
        reasoning: num([
          "Analyze Input \u2014 the merchant wants to rank discounts by usage.",
          "Identify Intent \u2014 chart_top_discounts_by_usage (READ, horizontal bar by usageCount).",
          "Determine Response \u2014 render the bar chart of the top 8 price rules.",
          "Plan Tool Calls \u2014 chart_top_discounts_by_usage(limit=8).",
        ]),
        toolCalls: [{ name: "chart_top_discounts_by_usage", args: { limit: 8 } }],
      };
    }
    // Generic chart ask with no specific metric named \u2014 default to inventory
    // by status, the visual analogue of the old summarize_inventory path.
    return {
      reasoning: num([
        "Analyze Input \u2014 generic chart request with no specific metric named.",
        "Identify Intent \u2014 chart_inventory_distribution by status (READ, donut).",
        "Determine Response \u2014 render the donut as a default overview.",
        'Plan Tool Calls \u2014 chart_inventory_distribution(dimension="status").',
      ]),
      toolCalls: [{ name: "chart_inventory_distribution", args: { dimension: "status" } }],
    };
  }

  // ── Product status change (the most-requested write). Two distinct signals
  //    to parse apart, which the old code conflated:
  //      SOURCE status = which products to search for (status:archived filter)
  //      TARGET status = what to change them TO (the write's status arg)
  //    "mark draft products as archived" → source=DRAFT, target=ARCHIVED.
  //    "make archived items active"       → source=ARCHIVED, target=ACTIVE.
  //
  //    Phrasing patterns we recognize:
  //      "<source> items as <target>"   → explicit both (best case)
  //      "mark X as <target>"            → target explicit, source = X (title)
  //      "archive X" / "activate X"      → verb-as-target, source = X (title)
  //      "make out-of-stock unavailable" → target=DRAFT, source = low-stock
  //
  //    The agent loop's expandWriteCall turns the single proposed write into
  //    one Approve card PER matched product, all in one turn.
  const STATUS_VALUES = ["ACTIVE", "DRAFT", "ARCHIVED", "UNLISTED"] as const;
  // Map natural-language words to the 4 canonical status values.
  const wordToStatus: Record<string, string> = {
    active: "ACTIVE", activate: "ACTIVE", live: "ACTIVE", available: "ACTIVE", listed: "ACTIVE", published: "ACTIVE", publish: "ACTIVE", sale: "ACTIVE", selling: "ACTIVE",
    draft: "DRAFT", unavailable: "DRAFT", "out of stock": "DRAFT", "out-of-stock": "DRAFT", discontinue: "DRAFT", discontinued: "DRAFT", hide: "DRAFT", hidden: "DRAFT", inactive: "DRAFT", deactivate: "DRAFT", unpublish: "DRAFT", unpublished: "DRAFT",
    archive: "ARCHIVED", archived: "ARCHIVED",
    unlist: "UNLISTED", unlisted: "UNLISTED",
  };
  const statusVerbKws = /\b(mark|set|make|put|switch|change|update|turn|go|archive|activate|deactivate|publish|unpublish|hide|unhide|discontinue|reinstate|restore|relist|relaunch|bring back)\b/i;
  // Find an explicit "<X> as <Y>" / "<X> to <Y>" target pattern first — this is
  // the unambiguous case. Y is the target status.
  const asMatch = m.match(/\b(?:as|to)\s+(active|activate|live|available|draft|unavailable|archive|archived|unlist(?:ed)?|inactive|hidden|published?|listed)\b/i);
  let targetStatus: string | null = null;
  if (asMatch && asMatch[1]) {
    const w = asMatch[1].toLowerCase();
    targetStatus = wordToStatus[w] ?? null;
  }
  // No "as <status>" pattern → look for a target verb ("archive the snowboard",
  // "activate draft products"). The verb itself implies the target.
  if (!targetStatus) {
    if (/\barchive[d]?\b/i.test(m)) targetStatus = "ARCHIVED";
    else if (/\b(activate|make active|make live|go live|bring back|reinstate|restore|relist|relaunch|republish|publish)\b/i.test(m)) targetStatus = "ACTIVE";
    else if (/\b(draft|unavailable|out.of.stock|discontinue|hide|unpublish|inactive|deactivate)\b/i.test(m)) targetStatus = "DRAFT";
    else if (/\bunlist(ed)?\b/i.test(m)) targetStatus = "UNLISTED";
  }

  // Now decide the SOURCE — which products to search for.
  // Look for a status word BEFORE the "as/to" target, or a status describing
  // the noun ("archived items", "draft products"). This is the source filter.
  let sourceStatus: string | null = null;
  if (asMatch && asMatch.index !== undefined) {
    // Scan the text before the "as/to" for a status word.
    const before = m.slice(0, asMatch.index);
    const srcW = before.match(/\b(active|archived?|draft|unlist(?:ed)?|unavailable|out.of.stock|inactive|hidden|discontinued?)\b/i);
    if (srcW && srcW[1]) {
      const w = srcW[1].toLowerCase();
      sourceStatus = wordToStatus[w] ?? null;
      // Don't let source == target (would mean "mark active as active").
      if (sourceStatus === targetStatus) sourceStatus = null;
    }
  }
  // Also catch "<status> items/products" phrasing anywhere (source by noun).
  if (!sourceStatus) {
    const nounSrc = m.match(/\b(active|archived?|draft|unlist(?:ed)?)\s+(?:items?|products?|listings?|ones?|those|these)\b/i);
    if (nounSrc && nounSrc[1]) {
      const w = nounSrc[1].toLowerCase();
      const s = wordToStatus[w] ?? null;
      if (s && s !== targetStatus) sourceStatus = s;
    }
  }

  // Trigger the status-change branch if we found a target AND a status verb.
  if (targetStatus && STATUS_VALUES.includes(targetStatus as typeof STATUS_VALUES[number]) && statusVerbKws.test(m)) {
    // Pick the read query:
    //   - sourceStatus set    → query: "status:<source>" (search the set)
    //   - named product       → query: "<name>" (title search)
    //   - neither             → low-stock fallback (broad "mark out-of-stock")
    const namedProduct = m.match(/\b(snowboard|shirt|coffee|mug|t-shirt|tshirt|tee|hat|cap|beanie|jacket|bag|book|bottle|sticker|poster|print|socks?|pants?|hoodie|sweater|skateboard|guitar|keyboard)\b/);
    let query: { name: "get_products"; args: { query?: string } } | { name: "get_low_stock_products"; args: {} };
    let searchDesc: string;
    if (sourceStatus) {
      const stVal = sourceStatus.toLowerCase();
      query = { name: "get_products", args: { query: `status:${stVal}` } };
      searchDesc = `status:${stVal} (search the set the merchant described, don't ask them to name products)`;
    } else if (namedProduct) {
      query = { name: "get_products", args: { query: namedProduct[1] } };
      searchDesc = `title:'${namedProduct[1]}'`;
    } else {
      query = { name: "get_low_stock_products", args: {} };
      searchDesc = "low-stock list (no specific product or status named)";
    }

    const reasoningLines = [
      `Analyze Input - the merchant wants to change products${sourceStatus ? ` currently in ${sourceStatus}` : ""} to ${targetStatus}.`,
      `Identify Intent - set_product_status (WRITE, propose). The agent will expand one proposal into one Approve card per matched product.`,
      `Determine Response - search for the target product(s) using ${searchDesc}, then propose the status change for each match in the same turn.`,
      `Plan Tool Calls - ${query.name} (execute) + set_product_status ${targetStatus} (propose, no id — agent fills from read).`,
    ];
    return {
      reasoning: num(reasoningLines),
      toolCalls: [
        query,
        { name: "set_product_status", args: { status: targetStatus }, disposition: "propose" },
      ],
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
        // variantId is intentionally omitted — expandWriteCall fills it from
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
