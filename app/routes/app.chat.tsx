// app/routes/app.chat.tsx — the chat API resource route.
//
// POST /app/chat { message, conversationId, effort } → AgentResponse
// Loads the authenticated Shopify admin client + shop, runs the agent against
// a specific conversation, returns the reply + action cards for the UI.

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { runAgent } from "../lib/agent.server";
import type { ReasoningEffort } from "../lib/llm.server";

const VALID_EFFORTS: ReasoningEffort[] = ["medium", "high", "max"];

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const body = (await request.json()) as { message?: string; conversationId?: string; effort?: string };
  const message = body?.message?.trim();

  if (!message) {
    return Response.json({ error: "Message is required" }, { status: 400 });
  }
  // conversationId is mandatory: every chat must belong to a Conversation row.
  // The UI creates one optimistically before the first send, so by the time we
  // get here it should exist. Guard against missing/empty just in case.
  const conversationId = body.conversationId?.trim();
  if (!conversationId) {
    return Response.json({ error: "conversationId is required" }, { status: 400 });
  }

  const effort: ReasoningEffort = VALID_EFFORTS.includes(body.effort as ReasoningEffort)
    ? (body.effort as ReasoningEffort)
    : "medium";

  const result = await runAgent({
    admin: admin as unknown as { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> },
    shop: session.shop,
    message,
    conversationId,
    effort,
  });

  return Response.json(result);
};
