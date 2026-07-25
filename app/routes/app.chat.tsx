// app/routes/app.chat.tsx — the chat API resource route.
//
// POST /app/chat { message: string } → { response, actions, provider }
// Loads the authenticated Shopify admin client + shop, runs the agent, returns
// the reply + action cards for the UI to render.

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { runAgent } from "../lib/agent.server";
import type { ReasoningEffort } from "../lib/llm.server";

const VALID_EFFORTS: ReasoningEffort[] = ["medium", "high", "max"];

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const body = (await request.json()) as { message?: string; effort?: string };
  const message = body?.message?.trim();

  if (!message) {
    return Response.json({ error: "Message is required" }, { status: 400 });
  }

  const effort: ReasoningEffort = VALID_EFFORTS.includes(body.effort as ReasoningEffort)
    ? (body.effort as ReasoningEffort)
    : "medium";

  const result = await runAgent({
    admin: admin as unknown as { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> },
    shop: session.shop,
    message,
    effort,
  });

  return Response.json(result);
};
