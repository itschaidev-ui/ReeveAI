// ────────────────────────────────────────────────────────────────────────────
// app/lib/agent.server.ts — the Reeve AI agent loop.
//
// Flow per merchant message:
//   1. Load recent chat history for context
//   2. Ask the LLM (NVIDIA) to plan a response + tool calls
//   3. Execute each tool call via the authenticated Shopify admin client
//   4. Compose a natural-language reply from the reasoning + action summaries
//   5. Persist the user message + assistant message (with actions) + log activity
// ────────────────────────────────────────────────────────────────────────────

import prisma from "../db.server";
import { askLlm, type LlmMessage } from "./llm.server";
import { dispatch, toolCatalog, type ToolCtx, type ToolName, type ToolResult } from "./agent-tools.server";
import { logActivity } from "./audit.server";

interface AdminClient {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
}

export interface AgentResponse {
  response: string;
  actions: ToolResult[];
  provider: "nvidia" | "demo";
}

export async function runAgent(params: {
  admin: AdminClient;
  shop: string;
  message: string;
}): Promise<AgentResponse> {
  const { admin, shop, message } = params;
  const ctx: ToolCtx = { admin, shop };

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

  // 4. Compose the reply.
  const response = composeReply(plan.reasoning, actions, plan.provider);

  // 5. Persist + audit.
  await prisma.chatMessage.create({ data: { shop, role: "user", content: message } });
  await prisma.chatMessage.create({
    data: {
      shop,
      role: "assistant",
      content: response,
      actionsJson: JSON.stringify(actions),
    },
  });
  await logActivity({
    shop,
    type: "agent_message",
    source: "agent",
    severity: actions.some((a) => !a.ok) ? "warning" : "info",
    message: `Reeve replied: ${response.slice(0, 140)}${response.length > 140 ? "…" : ""}`,
  });

  return { response, actions, provider: plan.provider };
}

function composeReply(reasoning: string, actions: ToolResult[], provider: string): string {
  const parts: string[] = [];
  if (reasoning?.trim()) parts.push(reasoning.trim());
  const succeeded = actions.filter((a) => a.ok);
  const failed = actions.filter((a) => !a.ok);
  if (succeeded.length) parts.push("✅ " + succeeded.map((a) => a.summary).join("  •  "));
  if (failed.length) parts.push("⚠️ " + failed.map((a) => `${a.summary} (${a.error})`).join("  •  "));
  const tag = provider === "nvidia" ? "" : " _(demo mode — set NVIDIA_API_KEY for live AI)_";
  return (parts.join("\n\n") || "Done.") + tag;
}
