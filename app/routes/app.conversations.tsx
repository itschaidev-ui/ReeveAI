// app/routes/app.conversations.tsx — Conversation CRUD resource route.
//
// POST   /app/conversations                      → { conversation }            (create)
// PATCH  /app/conversations  { id, title }       → { conversation }            (rename)
// DELETE /app/conversations  { id }              → { ok }                      (delete + cascade messages)
//
// All actions are scoped to the authenticated shop so a merchant can only
// touch their own conversations. Deletes cascade the ChatMessage rows in the
// same transaction so the sidebar never points at orphaned messages.

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

interface ConversationOut {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

const toOut = (c: { id: string; title: string; createdAt: Date; updatedAt: Date }): ConversationOut => ({
  id: c.id,
  title: c.title,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const method = request.method.toUpperCase();

  try {
    if (method === "POST") {
      // Create a new conversation with the default title. The agent auto-titles
      // it from the first user message; the UI can also rename anytime.
      const body = (await request.json().catch(() => ({}))) as { title?: string };
      const conv = await prisma.conversation.create({
        data: { shop, title: (body.title?.trim() || "New chat").slice(0, 120) },
      });
      return Response.json({ conversation: toOut(conv) });
    }

    if (method === "PATCH" || method === "PUT") {
      const body = (await request.json().catch(() => ({}))) as { id?: string; title?: string };
      const id = body.id?.trim();
      const title = body.title?.trim();
      if (!id || !title) return Response.json({ error: "id and title are required" }, { status: 400 });
      // Guard: scope by shop so cross-shop rename is impossible.
      const conv = await prisma.conversation.updateMany({ where: { id, shop }, data: { title: title.slice(0, 120) } });
      if (conv.count === 0) return Response.json({ error: "Conversation not found" }, { status: 404 });
      const fresh = await prisma.conversation.findUnique({ where: { id } });
      return Response.json({ conversation: fresh ? toOut(fresh) : null });
    }

    if (method === "DELETE") {
      const body = (await request.json().catch(() => ({}))) as { id?: string };
      const id = body.id?.trim();
      if (!id) return Response.json({ error: "id is required" }, { status: 400 });
      // Cascade in a transaction: messages first, then the conversation row.
      // Both scoped by shop so a leaked id can't delete another merchant's data.
      await prisma.$transaction([
        prisma.chatMessage.deleteMany({ where: { conversationId: id, shop } }),
        prisma.conversation.deleteMany({ where: { id, shop } }),
      ]);
      return Response.json({ ok: true });
    }

    return Response.json({ error: `Method ${method} not allowed` }, { status: 405 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return Response.json({ error: msg }, { status: 500 });
  }
};
