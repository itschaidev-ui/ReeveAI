// ────────────────────────────────────────────────────────────────────────────
// app/lib/agent.server.ts — the Reeve AI agent loop.
//
// Flow per merchant message:
//   1. Load recent chat history for context
//   2. Ask the LLM (NVIDIA) to plan a response + tool calls
//   3. Execute each tool call via the authenticated Shopify admin client
//   4. Second LLM call: produce the FINAL answer from the tool results
//   5. Persist the user message + assistant message (with actions) + log activity
// ────────────────────────────────────────────────────────────────────────────

import prisma from "../db.server";
import { askLlm, askLlmAnswer, type LlmMessage, type ReasoningEffort } from "./llm.server";
import { dispatch, toolCatalog, type ToolCtx, type ToolName, type ToolResult } from "./agent-tools.server";
import { logActivity } from "./audit.server";

interface AdminClient {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
}

export interface AgentResponse {
  /** Step-1 (planning) reasoning shown in the collapsible "Thinking" chip. */
  reasoning: string;
  /** Step-2 (final answer) prose the merchant reads as the message body. Built
   *  from the tool RESULTS, not the planning reasoning -- so it actually reflects
   *  what happened when the tools ran. */
  response: string;
  actions: ToolResult[];
  provider: "nvidia" | "demo";
  /** Wall-clock ms the agent took (planning + tools + final-answer generation). */
  elapsedMs: number;
}

export async function runAgent(params: {
  admin: AdminClient;
  shop: string;
  message: string;
  effort?: ReasoningEffort;
}): Promise<AgentResponse> {
  const { admin, shop, message } = params;
  const effort: ReasoningEffort = params.effort ?? "medium";
  const ctx: ToolCtx = { admin, shop };
  const startedAt = Date.now();

  // 1. Load recent history (last 10 turns) for context.
  const recent = await prisma.chatMessage.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  const history: LlmMessage[] = recent
    .reverse()
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
      content: m.content,
    }));

  // 2. Ask the LLM to plan.
  const plan = await askLlm(
    [...history, { role: "user", content: message }],
    toolCatalog,
    shop,
    effort,
  );

  // 3. Execute each tool call in order.
  const actions: ToolResult[] = [];
  for (const call of plan.toolCalls) {
    if (!(call.name in toolCatalog.reduce((a, t) => ({ ...a, [t.name]: true }), {} as Record<string, boolean>))) {
      actions.push({ name: call.name, args: call.args, result: null, summary: `Unknown tool: ${call.name}`, ok: false, error: "unknown tool" });
      continue;
    }
    const result = await dispatch(call.name as ToolName, call.args, ctx);
    actions.push(result);

    // Chain: if a query returned exactly one product/variant, fill the next
    // write call's missing ids from it (simple planning aid for demo mode).
    const next = plan.toolCalls[plan.toolCalls.indexOf(call) + 1];
    if (next && result.ok && Array.isArray(result.result) && result.result.length === 1) {
      const row = result.result[0] as Record<string, unknown>;
      if (next.args.variantId === undefined && row.variantId) next.args.variantId = row.variantId;
      if (next.args.productId === undefined && row.id) next.args.productId = row.id as string;
    }
  }

  // 4. Step 2: ask the LLM for the FINAL answer, fed the tool RESULTS.
  //    Body is no longer the planning reasoning glued to a summary — it is a
  //    clean, second-LLM-call answer that actually reflects what happened.
  const reasoning = plan.reasoning.trim();
  const toolResultSummary = actions.map((a) => ({
    name: a.name, summary: a.summary, ok: a.ok, error: a.error, result: a.result,
  }));
  const answerResult = await askLlmAnswer(
    [...history, { role: "user", content: message }],
    message,
    reasoning,
    toolResultSummary,
    shop,
    effort,
  );
  const elapsedMs = Date.now() - startedAt;
  const tag = answerResult.provider === "nvidia" ? "" : " (demo mode — set NVIDIA_API_KEY for live AI)";
  const response = (answerResult.answer || "Done.").trim() + tag;

  // 5. Persist + audit.
  await prisma.chatMessage.create({ data: { shop, role: "user", content: message } });
  await prisma.chatMessage.create({
    data: {
      shop,
      role: "assistant",
      content: response,
      reasoning: reasoning || null,
      elapsedMs,
      actionsJson: JSON.stringify(actions),
    },
  });
  await logActivity({
    shop,
    type: "agent_message",
    source: "agent",
    severity: actions.some((a) => !a.ok) ? "warning" : "info",
    message: `Reeve replied: ${response.slice(0, 140)}${response.length > 140 ? "..." : ""}`,
  });

  return { reasoning, response, actions, provider: answerResult.provider, elapsedMs };
}
