// app/routes/app.conversations.export.tsx — debug export of a conversation.
//
// GET /app/conversations/export?id=<conversationId>
//   → downloads a JSON file containing the conversation metadata + every
//     message (role, content, reasoning, elapsedMs, parsed actions) + the
//     audit-log Activity rows for that shop (so you can correlate agent
//     writes back to the messages). Intended for debugging — not user-facing.
//
// Returns Content-Disposition: attachment so the browser downloads it rather
// than rendering it inline.

import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  const conv = await prisma.conversation.findFirst({ where: { id, shop } });
  if (!conv) return Response.json({ error: "Conversation not found" }, { status: 404 });

  const messages = await prisma.chatMessage.findMany({
    where: { conversationId: id, shop },
    orderBy: { createdAt: "asc" },
  });

  // Activity rows are shop-scoped (not conversation-scoped in the schema), so
  // we include the recent slice for context. This is the debug view.
  const activity = await prisma.activity.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const payload = {
    exportedAt: new Date().toISOString(),
    shop,
    conversation: {
      id: conv.id,
      title: conv.title,
      createdAt: conv.createdAt.toISOString(),
      updatedAt: conv.updatedAt.toISOString(),
    },
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      reasoning: m.reasoning,
      elapsedMs: m.elapsedMs,
      actions: m.actionsJson ? safeParse(m.actionsJson) : null,
      createdAt: m.createdAt.toISOString(),
    })),
    recentActivity: activity.map((a) => ({
      id: a.id,
      type: a.type,
      severity: a.severity,
      source: a.source,
      message: a.message,
      before: a.beforeJson ? safeParse(a.beforeJson) : null,
      after: a.afterJson ? safeParse(a.afterJson) : null,
      createdAt: a.createdAt.toISOString(),
    })),
  };

  const safeTitle = conv.title.replace(/[^a-z0-9-_]+/gi, "_").slice(0, 40) || "conversation";
  const json = JSON.stringify(payload, null, 2);
  return new Response(json, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="reeve-${safeTitle}-${conv.id.slice(-6)}.json"`,
      "Cache-Control": "no-store",
    },
  });
};

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
