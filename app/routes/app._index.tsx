// app/routes/app._index.tsx — Reeve AI dashboard, embedded in Shopify.
//
// Layout: everything INLINE on the page (no overlay/orb — the app surface IS
// the Shopify iframe). Two-column via s-page's slot="aside": main column shows
// inventory KPIs + activity; the aside column is the persistent chat panel.
//
// Custom-element rule: Polaris web components are used only for STATIC display
// (string/boolean props). Interactive bits (textarea, send button, suggestion
// chips) are plain native DOM with standard React controlled binding — React 18
// + web-component controlled bindings (value/onChange/style) throw or break.

import { useEffect, useRef, useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getActivities } from "../lib/audit.server";
import prisma from "../db.server";

// ─── Loader: live inventory + chat history + activity ─────────────────────────

interface InventorySummary {
  total: number;
  inStock: number;
  lowStock: number;
  outOfStock: number;
  topLow: { id: string; title: string; inventory: number }[];
}
interface ChatAction { name: string; summary: string; ok: boolean; error?: string }
interface Message { id: string; role: string; content: string; actions: ChatAction[] | null }
interface ActivityItem { id: string; type: string; severity: string; source: string; message: string; createdAt: string }
interface LoaderData { summary: InventorySummary; messages: Message[]; activities: ActivityItem[]; provider: "nvidia" | "demo" }

export const loader = async ({ request }: LoaderFunctionArgs): Promise<LoaderData> => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  interface ProductsData {
    products: { edges: Array<{ node: { id: string; title: string; variants: { edges: Array<{ node: { inventoryQuantity: number | null } }> } } }> };
  }
  const res = await admin.graphql(
    `#graphql
    query DashboardProducts($first: Int!) {
      products(first: $first) {
        edges { node { id title variants(first: 5) { edges { node { inventoryQuantity } } } } }
      }
    }`,
    { variables: { first: 250 } },
  );
  const json = (await res.json()) as { data: ProductsData };

  let total = 0, inStock = 0, lowStock = 0, outOfStock = 0;
  const lowList: { id: string; title: string; inventory: number }[] = [];
  for (const e of json.data.products.edges) {
    const minInv = Math.min(...e.node.variants.edges.map((v) => v.node.inventoryQuantity ?? 0));
    total++;
    if (minInv <= 0) outOfStock++;
    else if (minInv <= 5) { lowStock++; lowList.push({ id: e.node.id, title: e.node.title, inventory: minInv }); }
    else inStock++;
  }
  lowList.sort((a, b) => a.inventory - b.inventory);

  const dbMessages = await prisma.chatMessage.findMany({ where: { shop }, orderBy: { createdAt: "desc" }, take: 20 });
  const activities = await getActivities(shop, 8);

  return {
    summary: { total, inStock, lowStock, outOfStock, topLow: lowList.slice(0, 5) },
    messages: dbMessages.reverse().map((m) => ({
      id: m.id, role: m.role, content: m.content,
      actions: m.actionsJson ? (JSON.parse(m.actionsJson) as ChatAction[]) : null,
    })),
    activities: activities.map((a) => ({
      id: a.id, type: a.type, severity: a.severity, source: a.source,
      message: a.message, createdAt: a.createdAt.toISOString(),
    })),
    provider: process.env.NVIDIA_API_KEY ? "nvidia" : "demo",
  };
};

// ─── Dashboard ──────────────────────────────────────────────────────────────────

export default function ReeveDashboard() {
  const { summary, messages: initialMessages, activities, provider } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof loader>();
  const chatFetcher = useFetcher<{ response?: string; actions?: ChatAction[]; provider?: string; error?: string }>();
  const shopify = useAppBridge();

  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastReplyRef = useRef<string | null>(null);

  useEffect(() => {
    if (fetcher.data?.messages) setMessages(fetcher.data.messages);
  }, [fetcher.data]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, chatFetcher.state]);

  const isThinking = chatFetcher.state !== "idle";

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isThinking) return;
    setMessages((m) => [...m, { id: `u-${Date.now()}`, role: "user", content: trimmed }]);
    setInput("");
    lastReplyRef.current = null;
    chatFetcher.submit({ message: trimmed }, { method: "POST", action: "/app/chat", encType: "application/json" });
  };

  useEffect(() => {
    if (chatFetcher.data?.response && chatFetcher.state === "idle") {
      const sig = chatFetcher.data.response;
      if (lastReplyRef.current !== sig) {
        lastReplyRef.current = sig;
        setMessages((m) => [...m, {
          id: `a-${Date.now()}`, role: "assistant",
          content: chatFetcher.data.response!, actions: chatFetcher.data.actions ?? null,
        }]);
        shopify.toast.show("Reeve replied");
        fetcher.load("/app");
      }
    }
    if (chatFetcher.data?.error && chatFetcher.state === "idle") {
      shopify.toast.show(chatFetcher.data.error, { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatFetcher.data, chatFetcher.state]);

  return (
    <s-page heading="Reeve AI">
      <div slot="primary-action">
        <s-badge tone={provider === "nvidia" ? "success" : "attention"}>
          {provider === "nvidia" ? "Live AI" : "Demo mode"}
        </s-badge>
      </div>

      {/* ─── MAIN COLUMN: inventory + activity ─── */}
      <s-section heading="Inventory at a glance">
        <s-stack direction="inline" gap="loose" wrap>
          <Stat label="Total products" value={summary.total} />
          <Stat label="In stock" value={summary.inStock} />
          <Stat label="Low stock" value={summary.lowStock} tone="caution" />
          <Stat label="Out of stock" value={summary.outOfStock} tone="critical" />
        </s-stack>

        {summary.topLow.length > 0 ? (
          <s-stack direction="block" gap="tight">
            <s-heading>Top products at risk</s-heading>
            {summary.topLow.map((p) => (
              <s-stack key={p.id} direction="inline" gap="base" align="center">
                <s-text>{p.title}</s-text>
                <s-badge tone={p.inventory <= 0 ? "critical" : "caution"}>{p.inventory} left</s-badge>
              </s-stack>
            ))}
          </s-stack>
        ) : (
          <s-paragraph>
            <s-text tone="subdued">No products at risk. Add products to your store to see inventory insights.</s-text>
          </s-paragraph>
        )}
      </s-section>

      <s-section heading="Recent activity">
        <s-stack direction="block" gap="tight">
          {activities.length === 0 ? (
            <s-text tone="subdued">No activity yet. Ask Reeve something in the chat →</s-text>
          ) : (
            activities.map((a) => (
              <s-box key={a.id} padding="base" background="subdued" borderRadius="base">
                <s-stack direction="inline" gap="base" align="center">
                  <s-badge tone={a.source === "agent" ? "info" : a.source === "user" ? "success" : "neutral"}>{a.source}</s-badge>
                  <s-text>{a.message}</s-text>
                </s-stack>
              </s-box>
            ))
          )}
        </s-stack>
      </s-section>

      {/* ─── ASIDE COLUMN: persistent chat panel (inline, not an overlay) ─── */}
      <div slot="aside" style={{ display: "flex", flexDirection: "column", height: "100%", maxHeight: "80vh" }}>
        {/* Chat header */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px", paddingBottom: "10px", borderBottom: "1px solid #e1e1e1", marginBottom: "10px" }}>
          <div style={{ width: "28px", height: "28px", borderRadius: "50%", background: "#000", color: "#FFD60A", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: "13px" }}>R</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: "13px", fontWeight: 600 }}>Reeve Agent</div>
            <div style={{ fontSize: "10px", color: "#666" }}>{provider === "nvidia" ? "Live AI" : "Demo mode"} · Inventory ops</div>
          </div>
        </div>

        {/* Messages */}
        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", paddingRight: "4px" }}>
          {messages.length === 0 && (
            <div style={{ textAlign: "center", color: "#999", fontSize: "12px", marginTop: "32px" }}>
              Hi — I'm Reeve. Ask me what's running low, or have me fix your stock levels.
            </div>
          )}
          {messages.map((m) => <MessageBubble key={m.id} msg={m} />)}
          {isThinking && (
            <div style={{ display: "flex", gap: "6px", alignItems: "center", color: "#999", fontSize: "12px", padding: "8px 0" }}>
              <span style={dotStyle(0)} /><span style={dotStyle(1)} /><span style={dotStyle(2)} />
              <span>Reeve is thinking…</span>
            </div>
          )}
        </div>

        {/* Suggestion chips */}
        <div style={{ padding: "8px 0", display: "flex", flexWrap: "wrap", gap: "5px" }}>
          {["What's running low?", "Summarize inventory", "Show products"].map((s) => (
            <button key={s} onClick={() => send(s)} disabled={isThinking} style={chipStyle}>{s}</button>
          ))}
        </div>

        {/* Composer */}
        <div style={{ display: "flex", gap: "6px", alignItems: "flex-end", paddingTop: "6px", borderTop: "1px solid #e1e1e1" }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }}
            placeholder="Message Reeve…"
            rows={2}
            style={{ flex: 1, resize: "none", border: "1px solid #e1e1e1", borderRadius: "8px", padding: "8px 10px", fontSize: "13px", fontFamily: "inherit", outline: "none", minHeight: "38px" }}
          />
          <button
            onClick={() => send(input)}
            disabled={!input.trim() || isThinking}
            style={{ background: input.trim() && !isThinking ? "#000" : "#ccc", color: "#FFD60A", border: "none", borderRadius: "8px", padding: "0 12px", height: "38px", cursor: input.trim() && !isThinking ? "pointer" : "default", fontWeight: 600, fontSize: "13px" }}
          >
            Send
          </button>
        </div>
      </div>
    </s-page>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
      <s-stack direction="block" gap="none">
        <s-text alignment="center" appearance="code" {...(tone ? { tone } : {})}>{value}</s-text>
        <s-text alignment="center" tone="subdued">{label}</s-text>
      </s-stack>
    </s-box>
  );
}

function MessageBubble({ msg }: { msg: Message }) {
  const isUser = msg.role === "user";
  return (
    <div style={{ marginBottom: "12px" }}>
      <div style={{
        display: "inline-block", maxWidth: "88%", padding: "8px 10px",
        borderRadius: isUser ? "10px 10px 2px 10px" : "10px 10px 10px 2px",
        background: isUser ? "#000" : "#f6f6f7", color: isUser ? "#fff" : "#000",
        fontSize: "12px", lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word",
        float: isUser ? "right" : "left", clear: "both",
      }}>
        {msg.content}
      </div>
      {msg.actions && msg.actions.length > 0 && (
        <div style={{ clear: "both", marginTop: "5px", display: "flex", flexDirection: "column", gap: "4px" }}>
          {msg.actions.map((a, i) => (
            <div key={i} style={{
              border: "1px solid", borderRadius: "5px", padding: "5px 7px", fontSize: "11px",
              background: a.ok ? "#fafafa" : "#fff0f0", borderColor: a.ok ? "#e1e1e1" : "#ffcaca",
            }}>
              <strong style={{ color: a.ok ? "#008060" : "#d72c0d" }}>{a.ok ? "✓" : "✗"}</strong> {a.summary}{a.error ? ` — ${a.error}` : ""}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const chipStyle: React.CSSProperties = {
  border: "1px solid #e1e1e1", background: "#f6f6f7", borderRadius: "999px",
  padding: "3px 9px", fontSize: "11px", color: "#666", cursor: "pointer",
};

function dotStyle(delay: number): React.CSSProperties {
  return {
    display: "inline-block", width: "5px", height: "5px", borderRadius: "50%", background: "#999",
    animation: "reeveBounce 1s infinite", animationDelay: `${delay * 0.15}s`,
  };
}

export const links = () => [
  { rel: "stylesheet", href: "data:text/css," + encodeURIComponent("@keyframes reeveBounce{0%,80%,100%{transform:scale(0.6);opacity:0.5}40%{transform:scale(1);opacity:1}}") },
];

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
