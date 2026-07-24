// app/routes/app._index.tsx — the Reeve AI dashboard, embedded in Shopify.
//
// Shows: live inventory summary (from Shopify), the AI chat panel (the hero),
// and recent audit activity. All reads go through the authenticated admin
// GraphQL client; chat POSTs to /app/chat.

import { useEffect, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getActivities } from "../lib/audit.server";
import prisma from "../db.server";

// ─── Loader: live inventory summary + recent activity ─────────────────────────

interface InventorySummary {
  total: number;
  inStock: number;
  lowStock: number;
  outOfStock: number;
  topLow: { id: string; title: string; inventory: number }[];
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  // Live inventory from Shopify.
  interface ProductsData {
    products: { edges: Array<{ node: { id: string; title: string; variants: { edges: Array<{ node: { inventoryQuantity: number | null } }> } } }> };
  }
  const res = await admin.graphql(`#graphql
    query DashboardProducts($first: Int!) {
      products(first: $first) {
        edges { node { id title variants(first: 5) { edges { node { inventoryQuantity } } } } }
      }
    }`, { variables: { first: 250 } });
  const data = (await res.json()) as { data: ProductsData };

  let total = 0, inStock = 0, lowStock = 0, outOfStock = 0;
  const lowList: { id: string; title: string; inventory: number }[] = [];
  for (const e of data.data.products.edges) {
    const minInv = Math.min(...e.node.variants.edges.map((v) => v.node.inventoryQuantity ?? 0));
    total++;
    if (minInv <= 0) outOfStock++;
    else if (minInv <= 5) { lowStock++; lowList.push({ id: e.node.id, title: e.node.title, inventory: minInv }); }
    else inStock++;
  }
  lowList.sort((a, b) => a.inventory - b.inventory);

  const summary: InventorySummary = { total, inStock, lowStock, outOfStock, topLow: lowList.slice(0, 5) };

  // Recent chat messages (so the conversation persists across reloads).
  const messages = await prisma.chatMessage.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const activities = await getActivities(shop, 6);

  return {
    summary,
    messages: messages.reverse().map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      actions: m.actionsJson ? JSON.parse(m.actionsJson) : null,
    })),
    activities: activities.map((a) => ({
      id: a.id,
      type: a.type,
      severity: a.severity,
      source: a.source,
      message: a.message,
      createdAt: a.createdAt,
    })),
    provider: process.env.NVIDIA_API_KEY ? "nvidia" : "demo",
  };
};

// ─── Component ──────────────────────────────────────────────────────────────────

interface ChatAction { name: string; summary: string; ok: boolean; error?: string }
interface Msg { id: string; role: string; content: string; actions: ChatAction[] | null }

export default function ReeveDashboard() {
  const { summary, messages: initialMessages, activities, provider } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof loader>();
  const chatFetcher = useFetcher<{ response?: string; actions?: ChatAction[]; provider?: string; error?: string }>();
  const shopify = useAppBridge();
  const [messages, setMessages] = useState<Msg[]>(initialMessages);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // When the loader re-runs (after a chat action invalidates), refresh messages + summary.
  useEffect(() => {
    if (fetcher.data) {
      setMessages(fetcher.data.messages);
    }
  }, [fetcher.data]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, chatFetcher.state]);

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || chatFetcher.state !== "idle") return;
    setMessages((m) => [...m, { id: crypto.randomUUID(), role: "user", content: trimmed }]);
    setInput("");
    chatFetcher.submit({ message: trimmed }, { method: "POST", action: "/app/chat", encType: "application/json" });
  };

  // When the chat fetcher returns, append the agent reply + reload data.
  useEffect(() => {
    if (chatFetcher.data?.response && chatFetcher.state === "idle") {
      setMessages((m) => [...m, {
        id: crypto.randomUUID(),
        role: "assistant",
        content: chatFetcher.data.response!,
        actions: chatFetcher.data.actions ?? null,
      }]);
      shopify.toast.show("Reeve replied");
      // Reload loader to refresh inventory + activity.
      fetcher.load("/app");
    }
    if (chatFetcher.data?.error) {
      shopify.toast.show(chatFetcher.data.error, { isError: true });
    }
  }, [chatFetcher.data, chatFetcher.state]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); }
  };

  const isThinking = chatFetcher.state !== "idle";

  return (
    <s-page heading="Reeve AI — Inventory Agent">
      <div slot="primary-action">
        <s-badge tone={provider === "nvidia" ? "success" : "attention"}>
          {provider === "nvidia" ? "Live AI" : "Demo mode"}
        </s-badge>
      </div>

      {/* ─── KPI tiles ─── */}
      <s-section heading="Inventory at a glance">
        <s-stack direction="inline" gap="loose" wrap>
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-stack direction="block" gap="none">
              <s-text alignment="center" appearance="code">{summary.total}</s-text>
              <s-text alignment="center" tone="subdued">Total products</s-text>
            </s-stack>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-stack direction="block" gap="none">
              <s-text alignment="center" appearance="code">{summary.inStock}</s-text>
              <s-text alignment="center" tone="subdued">In stock</s-text>
            </s-stack>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-stack direction="block" gap="none">
              <s-text alignment="center" tone="caution" appearance="code">{summary.lowStock}</s-text>
              <s-text alignment="center" tone="subdued">Low stock</s-text>
            </s-stack>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-stack direction="block" gap="none">
              <s-text alignment="center" tone="critical" appearance="code">{summary.outOfStock}</s-text>
              <s-text alignment="center" tone="subdued">Out of stock</s-text>
            </s-stack>
          </s-box>
        </s-stack>

        {summary.topLow.length > 0 && (
          <s-stack direction="block" gap="tight">
            <s-heading>Top products at risk</s-heading>
            {summary.topLow.map((p) => (
              <s-stack key={p.id} direction="inline" gap="base" align="center">
                <s-text>{p.title}</s-text>
                <s-badge tone={p.inventory <= 0 ? "critical" : "caution"}>{p.inventory} left</s-badge>
              </s-stack>
            ))}
          </s-stack>
        )}
      </s-section>

      {/* ─── Chat panel (the hero) ─── */}
      <s-section heading="Ask Reeve">
        <div ref={scrollRef} style={{ maxHeight: "320px", overflowY: "auto" }}>
          <s-stack direction="block" gap="base">
            {messages.map((m) => (
              <ChatMessage key={m.id} msg={m} />
            ))}
            {isThinking && (
              <s-box padding="base" background="subdued" borderRadius="base">
                <s-text tone="subdued">Reeve is thinking…</s-text>
              </s-box>
            )}
          </s-stack>
        </div>

        <s-stack direction="inline" gap="tight" align="end">
          <s-textarea
            placeholder="Ask Reeve about your inventory…"
            value={input}
            onInput={(e: Event) => setInput((e.target as HTMLTextAreaElement).value)}
            onKeyDown={onKeyDown}
            style={{ flexGrow: 1, minHeight: "60px" }}
          />
          <s-button onClick={() => send(input)} loading={isThinking}>
            Send
          </s-button>
        </s-stack>

        <s-stack direction="inline" gap="tight" wrap>
          <s-button variant="tertiary" onClick={() => send("What's running low?")}>What's running low?</s-button>
          <s-button variant="tertiary" onClick={() => send("Summarize my inventory health")}>Summarize health</s-button>
          <s-button variant="tertiary" onClick={() => send("Show me my products")}>Show products</s-button>
        </s-stack>
      </s-section>

      {/* ─── Recent activity (audit log) ─── */}
      <s-section heading="Recent activity">
        <s-stack direction="block" gap="tight">
          {activities.length === 0 ? (
            <s-text tone="subdued">No activity yet. Ask Reeve something above.</s-text>
          ) : (
            activities.map((a) => (
              <s-box key={a.id} padding="base" background="subdued" borderRadius="base">
                <s-stack direction="inline" gap="base" align="center">
                  <s-badge tone={a.source === "agent" ? "info" : a.source === "user" ? "success" : "neutral"}>
                    {a.source}
                  </s-badge>
                  <s-text>{a.message}</s-text>
                </s-stack>
              </s-box>
            ))
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

function ChatMessage({ msg }: { msg: Msg }) {
  const isUser = msg.role === "user";
  return (
    <s-box
      padding="base"
      borderRadius="base"
      background={isUser ? "subdued" : "transparent"}
      borderWidth={isUser ? "none" : "base"}
    >
      <s-stack direction="block" gap="tight">
        <s-text tone="subdued" appearance="code">{isUser ? "You" : "Reeve"}</s-text>
        <s-text>{msg.content}</s-text>
        {msg.actions && msg.actions.length > 0 && (
          <s-stack direction="block" gap="tight">
            {msg.actions.map((a, i) => (
              <s-box key={i} padding="tight" borderRadius="base" background="subdued">
                <s-stack direction="inline" gap="tight" align="center">
                  <s-badge tone={a.ok ? "success" : "critical"}>{a.ok ? "✓" : "✗"}</s-badge>
                  <s-text>{a.summary}</s-text>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-stack>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
