// app/routes/app.chat.approve.tsx — the Approve endpoint.
//
// POST /app/chat/approve { tool, args }
//   -> looks up the merchant's authenticated Shopify admin client
//   -> runs the proposed WRITE tool via dispatch()
//   -> returns the resulting action card { action: ToolResult } so the client
//      can swap the pending Approve card for a real success/failure card.
//
// This is the ONLY path through which WRITE tools actually mutate Shopify state.
// The main agent loop (runAgent) collects proposed writes into pendingWrites[]
// but never executes them — the merchant must click Approve, which posts here.

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { dispatch, isWriteTool, type ToolName, type ToolResult } from "../lib/agent-tools.server";
import { logActivity } from "../lib/audit.server";

const VALID_WRITE_TOOLS = ["update_inventory", "set_product_status", "update_price"];

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const body = (await request.json()) as { tool?: string; args?: Record<string, unknown> };

  const tool = body.tool;
  const args = body.args ?? {};

  if (!tool || !VALID_WRITE_TOOLS.includes(tool) || !isWriteTool(tool)) {
    return Response.json({ error: `Unknown or non-write tool: ${tool ?? "(missing)"}` }, { status: 400 });
  }

  const result: ToolResult = await dispatch(tool as ToolName, args, {
    admin: admin as unknown as { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> },
    shop: session.shop,
  });

  // Always log the approval event so there's an audit row for the merchant's
  // write decision, whether it succeeded or failed.
  await logActivity({
    shop: session.shop,
    type: "write_approved",
    source: "user",
    severity: result.ok ? "success" : "warning",
    message: `Approved ${tool}: ${result.summary}${result.ok ? "" : ` — ${result.error ?? "failed"}`}`,
  });

  return Response.json({ action: result });
};
