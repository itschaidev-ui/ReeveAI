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
import { dispatch, describeWriteCall, toolCatalog, isWriteTool, type ToolCtx, type ToolName, type ToolResult } from "./agent-tools.server";
import { logActivity } from "./audit.server";

interface AdminClient {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
}

export interface PendingWrite {
  /** Stable id for the client to track this proposal through approve/cancel. */
  nonce: string;
  tool: string;
  args: Record<string, unknown>;
  /** One-line human-readable description of what approving will do. */
  summary: string;
}

export interface AgentResponse {
  /** Step-1 (planning) reasoning shown in the collapsible "Thinking" chip. */
  reasoning: string;
  /** Step-2 (final answer) prose the merchant reads as the message body. */
  response: string;
  actions: ToolResult[];
  /** WRITE tools the model proposed but did not execute. The client renders
   *  Approve cards for these; the actual mutation only fires when the merchant
   *  clicks Approve (separate POST to /app/chat/approve). READ tools are NOT
   *  in here -- those ran immediately and their results are in actions. */
  pendingWrites: PendingWrite[];
  provider: "nvidia" | "demo";
  /** Wall-clock ms the agent took (planning + tools + final-answer generation). */
  elapsedMs: number;
}

export async function runAgent(params: {
  admin: AdminClient;
  shop: string;
  message: string;
  conversationId: string;
  effort?: ReasoningEffort;
}): Promise<AgentResponse> {
  const { admin, shop, message, conversationId } = params;
  const effort: ReasoningEffort = params.effort ?? "medium";
  const ctx: ToolCtx = { admin, shop };
  const startedAt = Date.now();

  // 0. Auto-title: the first user message in a conversation with the default
  //    title ("New chat") becomes the title (first ~60 chars of the message).
  //    This runs BEFORE we persist the new user message so the sidebar updates
  //    immediately when a fresh chat gets its first reply.
  const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (conv && conv.title === "New chat") {
    const existingUserMsgs = await prisma.chatMessage.count({
      where: { conversationId, role: "user" },
    });
    if (existingUserMsgs === 0) {
      const title = message.trim().slice(0, 60) + (message.trim().length > 60 ? "…" : "");
      await prisma.conversation.update({ where: { id: conversationId }, data: { title } });
    }
  }

  // 1. Load recent history scoped to THIS conversation (last 10 turns).
  const recent = await prisma.chatMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  const history: LlmMessage[] = recent
    .reverse()
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      if (m.role !== "assistant") {
        return { role: "user" as const, content: m.content };
      }
      // For assistant turns, append a compact machine-readable block of the
      // tool action results (product/variant/location ids) so the model can
      // reference them in follow-up write proposals on later turns. Without
      // this, the model has no way to know which productId to propose.
      let content = m.content;
      if (m.actionsJson) {
        try {
          const acts = JSON.parse(m.actionsJson) as Array<{
            name: string; ok: boolean; result?: unknown; summary?: string;
          }>;
          const ids: string[] = [];
          for (const a of acts) {
            if (!a.ok || !Array.isArray(a.result)) continue;
            for (const row of a.result as Array<Record<string, unknown>>) {
              if (typeof row.id === "string") ids.push(`${a.name}:${row.id}:${typeof row.title === "string" ? row.title : ""}`);
              if (Array.isArray(row.variants)) {
                for (const v of row.variants as Array<Record<string, unknown>>) {
                  if (typeof v.id === "string") ids.push(`variant:${v.id}`);
                }
              }
            }
          }
          if (ids.length) {
            content += `\n[VISIBLE TOOL RESULT IDS — use these to target writes]:\n${ids.slice(0, 40).join("\n")}`;
          }
        } catch { /* malformed actionsJson — skip */ }
      }
      return { role: "assistant" as const, content };
    });

  // 2. Ask the LLM to plan.
  const plan = await askLlm(
    [...history, { role: "user", content: message }],
    toolCatalog,
    shop,
    effort,
  );

  // 3. Split the plan into reads (execute immediately) and writes (collect as
  //    pending approvals -- never execute automatically). Either signal is
  //    enough: the model can declare disposition="propose" OR we fall back to
  //    isWriteTool(name) for safety in case the model forgets the field.
  const known = toolCatalog.reduce((a, t) => ({ ...a, [t.name]: true }), {} as Record<string, boolean>);
  const actions: ToolResult[] = [];
  const pendingWrites: PendingWrite[] = [];
  for (const call of plan.toolCalls) {
    if (!(call.name in known)) {
      actions.push({ name: call.name, args: call.args, result: null, summary: `Unknown tool: ${call.name}`, ok: false, error: "unknown tool" });
      continue;
    }
    const wantsPropose = call.disposition === "propose" || isWriteTool(call.name);
    if (wantsPropose) {
      // Auto-resolve missing target ids from this turn's already-executed read
      // results. Lets the model propose a write against "the first low-stock
      // product" without needing a re-plan loop.
      const resolved = resolveWriteArgs(call.name, call.args, actions);
      pendingWrites.push({
        nonce: `pw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        tool: call.name,
        args: resolved.args,
        // If we filled missing ids, surface that in the summary so the merchant
        // can see WHICH product the write targets (not a blank id-tail).
        summary: resolved.filledFromRead
          ? describeWriteCall(call.name, resolved.args) + ` (from "${resolved.filledFromRead}")`
          : describeWriteCall(call.name, resolved.args),
      });
      continue;
    }

    const result = await dispatch(call.name as ToolName, call.args, ctx);
    actions.push(result);

    // Chain: if a query returned exactly one product/variant, fill the next
    // READ call's missing ids from it (simple planning aid for demo mode).
    const next = plan.toolCalls[plan.toolCalls.indexOf(call) + 1];
    if (next && !isWriteTool(next.name) && result.ok && Array.isArray(result.result) && result.result.length === 1) {
      const row = result.result[0] as Record<string, unknown>;
      if (next.args.variantId === undefined && row.variantId) next.args.variantId = row.variantId;
      if (next.args.productId === undefined && row.id) next.args.productId = row.id as string;
    }
  }

  // 4. Step 2: ask the LLM for the FINAL answer, fed the tool RESULTS (reads)
  //    AND a note about any pending write proposals so it can phrase the
  //    answer correctly ("I'm waiting for you to approve the DRAFT change").
  const reasoning = plan.reasoning.trim();
  const toolResultSummary = actions.map((a) => ({
    name: a.name, summary: a.summary, ok: a.ok, error: a.error, result: a.result,
  }));
  const pendingSummary = pendingWrites.length
    ? `\n\n[PROPOSED WRITES — awaiting merchant approval]: ${pendingWrites.map((p) => p.summary).join("; ")}`
    : "";
  // Explicit gate status for the answer LLM. Without this, the model has been
  // observed hallucinating "X has been set to ACTIVE" even though no write
  // actually executed this turn (writes only run after the merchant clicks
  // Approve on the next turn). This block makes the state unambiguous.
  const writeGateSummary = pendingWrites.length
    ? `\n\n[WRITE GATE STATUS — READ CAREFULLY]: ${pendingWrites.length} write(s) PROPOSED but NONE EXECUTED. The merchant has NOT approved them yet. They will run on the NEXT turn only if the merchant says yes or clicks Approve. Do NOT describe any write as completed/done/applied/successful this turn — use "I have proposed X, awaiting your approval".`
    : (actions.some((a) => isWriteTool(a.name))
      ? `\n\n[WRITE GATE STATUS]: No writes were proposed or executed this turn.`
      : "");
  const answerResult = await askLlmAnswer(
    [...history, { role: "user", content: message }],
    message + pendingSummary + writeGateSummary,
    reasoning,
    toolResultSummary,
    shop,
    effort,
  );
  const elapsedMs = Date.now() - startedAt;
  const tag = answerResult.provider === "nvidia" ? "" : " (demo mode — set NVIDIA_API_KEY for live AI)";
  let response = (answerResult.answer || "Done.").trim() + tag;

  // HARD BACKSTOP against hallucination. If the body claims a write happened
  // (proposed/done/applied/set/updated/marked/restocked) but the agent loop
  // collected zero pendingWrites AND executed zero write actions, override the
  // body with a truthful correction. The model has been observed saying "I have
  // proposed setting all 18 products to ACTIVE" while emitting zero write tool
  // calls — this catches that lie deterministically.
  const writeClaimRegex = /\b(i have|ive|i|we)\s+(proposed|set|marked|updated|changed|applied|restocked|made)\b/i;
  const noWritesThisTurn = pendingWrites.length === 0 && !actions.some((a) => isWriteTool(a.name));
  if (noWritesThisTurn && writeClaimRegex.test(response)) {
    response = "I wasn\'t able to propose any writes this turn — I can show you the relevant products, but to actually change one I\'ll need you to ask about a specific product by name. Which product would you like me to update, and to what?";
  }

  // 5. Persist + audit. Both messages carry the conversationId so the loader
  //    can scope by conversation. Bump the conversation's updatedAt so the
  //    sidebar ordering reflects the most-recently-active chat.
  await prisma.chatMessage.create({ data: { shop, conversationId, role: "user", content: message } });
  await prisma.chatMessage.create({
    data: {
      shop,
      conversationId,
      role: "assistant",
      content: response,
      reasoning: reasoning || null,
      elapsedMs,
      actionsJson: JSON.stringify(actions),
    },
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  }).catch(() => { /* conversation may have been deleted mid-run; ignore */ });
  await logActivity({
    shop,
    type: "agent_message",
    source: "agent",
    severity: actions.some((a) => !a.ok) ? "warning" : "info",
    message: `Reeve replied: ${response.slice(0, 140)}${response.length > 140 ? "..." : ""}`,
  });

  return { reasoning, response, actions, pendingWrites, provider: answerResult.provider, elapsedMs };
}

/**
 * If a proposed write is missing its target id(s), try to fill them from this
 * turn's already-executed READ action results. Returns the (possibly modified)
 * args plus a hint about which read row we sourced them from, so the summary
 * card can show the merchant what was matched.
 *
 * This is the band-aid for the missing re-plan loop: without it, the model
 * cannot propose a write for "the first low-stock product" because at plan
 * time it has not seen the read result yet.
 */
function resolveWriteArgs(
  toolName: string,
  args: Record<string, unknown>,
  actions: ToolResult[],
): { args: Record<string, unknown>; filledFromRead?: string } {
  const out = { ...args };
  let filledFromRead: string | undefined;

  // Find the first read action that returned a non-empty product/variant list.
  const readWithRows = actions.find(
    (a) => a.ok && Array.isArray(a.result) && (a.result as unknown[]).length > 0,
  );
  if (!readWithRows) return { args: out };

  const rows = readWithRows.result as Array<Record<string, unknown>>;
  const firstRow = rows[0];
  const firstTitle = typeof firstRow.title === "string" ? firstRow.title : readWithRows.name;
  filledFromRead = firstTitle;

  if (toolName === "set_product_status" && !out.productId && typeof firstRow.id === "string") {
    out.productId = firstRow.id;
  }
  if ((toolName === "update_price" || toolName === "update_inventory") && !out.variantId) {
    // Prefer a variant id on the first row; fall back to the row's own id.
    const variants = Array.isArray(firstRow.variants) ? (firstRow.variants as Array<Record<string, unknown>>) : [];
    const firstVariant = variants[0];
    if (firstVariant && typeof firstVariant.id === "string") out.variantId = firstVariant.id;
    else if (typeof firstRow.id === "string") out.variantId = firstRow.id;
  }

  return { args: out, filledFromRead };
}
