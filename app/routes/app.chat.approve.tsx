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
// Real Shopify gids look like "gid://shopify/Product/123456789". A pending write
// that reaches Approve without one means the agent loop's fill step failed (or
// the model emitted a placeholder that slipped through). Fail fast with a clear
// message instead of letting GraphQL produce a cryptic "Invalid global id".
const GID_RE = /^gid:\/\/shopify\/[A-Za-z]+\/\d+/;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const body = (await request.json()) as { tool?: string; args?: Record<string, unknown> };

  const tool = body.tool;
  const args = body.args ?? {};

  if (!tool || !VALID_WRITE_TOOLS.includes(tool) || !isWriteTool(tool)) {
    return Response.json({ error: `Unknown or non-write tool: ${tool ?? "(missing)"}` }, { status: 400 });
  }

  // Validate the target id is a real Shopify gid before dispatching. Which
  // field is required depends on the tool.
  const idField = tool === "set_product_status" ? "productId" : "variantId";
  const idVal = args[idField];
  if (typeof idVal !== "string" || !GID_RE.test(idVal)) {
    return Response.json({
      error: `This proposed write is missing a valid product id (got "${String(idVal)}"). Ask Reeve to search for the product again so it can target the right one.`,
    }, { status: 400 });
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
