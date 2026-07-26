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
      // Resolve + EXPAND. If the write is missing its target id AND a prior
      // read this turn returned multiple matching rows, expand the single
      // proposed write into one pending write PER row. This is the fix for the
      // "3-turn dance": instead of asking the merchant to re-name the product
      // after we already found it, we propose N writes right here.
      //
      // Single-row case behaves exactly as before (one write, one Approve card).
      const expanded = expandWriteCall(call.name, call.args, actions);
      for (const ex of expanded) {
        pendingWrites.push({
          nonce: `pw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${Math.random().toString(36).slice(2, 5)}`,
          tool: call.name,
          args: ex.args,
          summary: ex.filledFromRead
            ? describeWriteCall(call.name, ex.args) + ` (from "${ex.filledFromRead}")`
            : describeWriteCall(call.name, ex.args),
        });
      }
      // Edge case: model proposed a write but we couldn't resolve a target id
      // (no read ran, the read returned 0 rows, or the read failed). DO NOT
      // surface a broken Approve card — a write with no target id can never be
      // approved and just confuses the merchant. Instead, push a synthetic
      // action card that explains the gap, so the answer LLM + UI can phrase it
      // honestly ("I searched but found no products matching that").
      if (expanded.length === 0) {
        const readRan = actions.some((a) => !isWriteTool(a.name));
        const anyEmptyRead = actions.some((a) => !isWriteTool(a.name) && a.ok && Array.isArray(a.result) && (a.result as unknown[]).length === 0);
        const readFailed = actions.some((a) => !isWriteTool(a.name) && !a.ok);
        const reason = anyEmptyRead
          ? "Search returned no matching products — nothing to update."
          : readFailed
            ? "Search failed, so I couldn't determine which product to update."
            : readRan
              ? "Search returned results but I couldn't resolve a target product id."
              : "No search ran before this write, so I have no product to target.";
        actions.push({
          name: call.name, args: call.args, result: null,
          summary: `Proposed write skipped — ${reason}`,
          ok: false, error: reason,
        });
        // Do NOT push to pendingWrites. No broken Approve card.
      }
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
      // Distinguish WHY no writes were proposed. The most common cause is the
      // search returned no matches (the set the merchant described is empty).
      // In that case the model should say "found none" — NOT "name a product".
      ? (() => {
          const anyEmptyRead = actions.some((a) => !isWriteTool(a.name) && a.ok && Array.isArray(a.result) && (a.result as unknown[]).length === 0);
          const readFailed = actions.some((a) => !isWriteTool(a.name) && !a.ok);
          if (anyEmptyRead) {
            return `\n\n[WRITE GATE STATUS]: No writes were proposed because the search returned NO matching products. Tell the merchant you found none matching their criteria. Do NOT ask them to name a product — the search already ran and the set is empty. If they expected matches, suggest they check the status filter or try a different condition.`;
          }
          if (readFailed) {
            return `\n\n[WRITE GATE STATUS]: No writes were proposed because a search FAILED. Tell the merchant the search hit an error and suggest retrying.`;
          }
          return `\n\n[WRITE GATE STATUS]: No writes were proposed or executed this turn. If you have product results but couldn't resolve a target, ask the merchant to name a specific product. If you didn't search, search now is not possible (this turn is over) — tell the merchant what you need them to specify.`;
        })()
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
  //
  // The correction message distinguishes the two common zero-write causes:
  //   (a) a search ran but returned no matches (e.g. "no archived products")
  //   (b) no search ran at all (the model never looked)
  // so the merchant gets an actionable next step instead of a generic apology.
  const writeClaimRegex = /\b(i have|ive|i|we)\s+(proposed|set|marked|updated|changed|applied|restocked|made)\b/i;
  const noWritesThisTurn = pendingWrites.length === 0 && !actions.some((a) => isWriteTool(a.name));
  if (noWritesThisTurn && writeClaimRegex.test(response)) {
    const readsRan = actions.filter((a) => !isWriteTool(a.name));
    const anyEmptyResult = readsRan.some((a) => Array.isArray(a.result) && a.result.length === 0);
    if (readsRan.length > 0 && anyEmptyResult) {
      response = "I searched but found no products matching that — so there's nothing to change. If you expect matches, try a different status filter or product name and I'll search again.";
    } else if (readsRan.length > 0) {
      response = "I found some products but couldn't resolve which one to write to. Tell me the specific product name (or status, like 'archived') and I'll search and propose the change in one go.";
    } else {
      response = "I wasn't able to propose any writes this turn. Tell me the product name (or a status like 'archived') and what you want changed, and I'll search and propose it in one turn.";
    }
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
 * Resolve + EXPAND a proposed write call against this turn's already-executed
 * READ results. If the write is missing its target id AND a prior read returned
 * a list of candidate products/variants, we materialize one resolved write per
 * matched row — collapsing "search → ask user → ask user again → propose" into
 * a single turn.
 *
 * Behavior:
 *   - Write already has its id (model provided it from history): pass through
 *     unchanged as a single-element array. No expansion.
 *   - Write is missing id, read returned N>0 rows: return N resolved writes,
 *     one per row. Each gets a `filledFromRead` hint (the product title) so the
 *     Approve card shows WHICH product that write targets.
 *   - Write is missing id, no read returned rows: return [] (caller surfaces a
 *     single placeholder so the answer LLM can explain the gap).
 *
 * CAP: to avoid runaway batch writes (e.g. "mark all 250 products active"),
 * expansion is capped at MAX_BATCH. Beyond that the model is expected to ask
 * the merchant to scope the request; we surface the truncation in reasoning.
 */
const MAX_BATCH = 25;
/** A real Shopify global id looks like "gid://shopify/Product/123456789".
 *  Anything else — "PLACEHOLDER", "DEMO-PLACEHOLDER", "TODO", "null", "123" —
 *  is the model flagging "I don't have the real id, please fill it" and must
 *  NOT short-circuit expansion. Without this check the live LLM emitting
 *  productId:"PLACEHOLDER" was treated as a real id, bypassing the read-result
 *  fill, and the Approve click then failed with "Invalid global id 'PLACEHOLDER'". */
const GID_RE = /^gid:\/\/shopify\/[A-Za-z]+\/\d+/;
function isRealGid(v: unknown): boolean {
  return typeof v === "string" && GID_RE.test(v);
}

function expandWriteCall(
  toolName: string,
  args: Record<string, unknown>,
  actions: ToolResult[],
): Array<{ args: Record<string, unknown>; filledFromRead?: string }> {
  const out = { ...args };

  // If the model already supplied a REAL Shopify gid, no expansion needed.
  // (Placeholders like "PLACEHOLDER" / "DEMO-PLACEHOLDER" fall through to
  // expansion so the read result fills them.)
  const hasId =
    (toolName === "set_product_status" && isRealGid(out.productId)) ||
    ((toolName === "update_price" || toolName === "update_inventory") && isRealGid(out.variantId));
  if (hasId) return [{ args: out }];

  // Clear any non-gid placeholder so it doesn't leak into a pending write when
  // no read produced rows (the caller surfaces a single card from the args).
  if (toolName === "set_product_status" && !isRealGid(out.productId)) delete out.productId;
  if ((toolName === "update_price" || toolName === "update_inventory") && !isRealGid(out.variantId)) delete out.variantId;

  // Find the first read action that returned a non-empty product/variant list.
  const readWithRows = actions.find(
    (a) => a.ok && Array.isArray(a.result) && (a.result as unknown[]).length > 0,
  );
  if (!readWithRows) return [];

  const rows = (readWithRows.result as Array<Record<string, unknown>>).slice(0, MAX_BATCH);
  const expanded: Array<{ args: Record<string, unknown>; filledFromRead?: string }> = [];

  for (const row of rows) {
    const rowArgs = { ...out };
    const title = typeof row.title === "string" ? row.title : undefined;

    if (toolName === "set_product_status" && typeof row.id === "string") {
      rowArgs.productId = row.id;
      expanded.push({ args: rowArgs, filledFromRead: title });
      continue;
    }
    if (toolName === "update_price" || toolName === "update_inventory") {
      // Prefer a variant id on the row; fall back to the row's own id.
      const variants = Array.isArray(row.variants) ? (row.variants as Array<Record<string, unknown>>) : [];
      const firstVariant = variants[0];
      const variantId = (firstVariant && typeof firstVariant.id === "string")
        ? firstVariant.id
        : (typeof row.id === "string" ? row.id : undefined);
      if (variantId) {
        rowArgs.variantId = variantId;
        expanded.push({ args: rowArgs, filledFromRead: title });
      }
    }
  }

  return expanded;
}
