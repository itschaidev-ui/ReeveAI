// app/routes/app._index.tsx — Reeve AI as a FULL-PAGE chat.
//
// The whole app surface is the chat. No KPI tiles, no panels, no aside — just
// a big chat that fills the page. The inventory summary + activity are loaded
// for the agent to reference + shown as a welcome context card before the first
// message, but the chat is the hero and occupies everything.
//
// Custom-element rule: Polaris web components only for static display. The chat
// (textarea, send button, message bubbles, chips) is plain native DOM with
// standard React controlled binding.

import { useEffect, useRef, useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getActivities } from "../lib/audit.server";
import prisma from "../db.server";

// ─── Loader ───────────────────────────────────────────────────────────────────

interface InventorySummary { total: number; inStock: number; lowStock: number; outOfStock: number; topLow: { id: string; title: string; inventory: number }[] }
interface ChatAction { name: string; summary: string; ok: boolean; error?: string }
interface Message { id: string; role: string; content: string; actions: ChatAction[] | null }
interface LoaderData { summary: InventorySummary; messages: Message[]; provider: "nvidia" | "demo" }

export const loader = async ({ request }: LoaderFunctionArgs): Promise<LoaderData> => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  interface ProductsData { products: { edges: Array<{ node: { id: string; title: string; variants: { edges: Array<{ node: { inventoryQuantity: number | null } }> } } }> } }
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

  const dbMessages = await prisma.chatMessage.findMany({ where: { shop }, orderBy: { createdAt: "desc" }, take: 30 });

  return {
    summary: { total, inStock, lowStock, outOfStock, topLow: lowList.slice(0, 5) },
    messages: dbMessages.reverse().map((m) => ({
      id: m.id, role: m.role, content: m.content,
      actions: m.actionsJson ? (JSON.parse(m.actionsJson) as ChatAction[]) : null,
    })),
    provider: process.env.NVIDIA_API_KEY ? "nvidia" : "demo",
  };
};

// ─── Full-page chat ─────────────────────────────────────────────────────────────

export default function ReeveChat() {
  const { summary, messages: initialMessages, provider } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof loader>();
  const chatFetcher = useFetcher<{ response?: string; actions?: ChatAction[]; error?: string }>();
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

  const showWelcome = messages.length === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", maxHeight: "100vh", background: "#fff" }}>
      {/* ─── Header ─── */}
      <div style={{ display: "flex", alignItems: "center", gap: "12px", padding: "14px 20px", borderBottom: "1px solid #e1e1e1", background: "#000", color: "#fff", flexShrink: 0 }}>
        <div style={{ width: "36px", height: "36px", borderRadius: "50%", background: "#FFD60A", color: "#000", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: "17px" }}>R</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: "16px", fontWeight: 600 }}>Reeve AI</div>
          <div style={{ fontSize: "12px", opacity: 0.7 }}>Your Shopify inventory intern · {provider === "nvidia" ? "Live AI" : "Demo mode"}</div>
        </div>
        <div style={{ background: provider === "nvidia" ? "#008060" : "#FFD60A", color: provider === "nvidia" ? "#fff" : "#000", padding: "3px 10px", borderRadius: "999px", fontSize: "11px", fontWeight: 600 }}>
          {provider === "nvidia" ? "● Live" : "Demo"}
        </div>
      </div>

      {/* ─── Messages (fills available space) ─── */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "24px 20px", maxWidth: "820px", width: "100%", margin: "0 auto" }}>
        {showWelcome && (
          <WelcomeCard summary={summary} />
        )}
        {messages.map((m) => <MessageBubble key={m.id} msg={m} />)}
        {isThinking && (
          <div style={{ display: "flex", gap: "8px", alignItems: "center", color: "#666", fontSize: "14px", padding: "12px 0" }}>
            <div style={{ width: "28px", height: "28px", borderRadius: "50%", background: "#000", color: "#FFD60A", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: "12px" }}>R</div>
            <span style={dotStyle(0)} /><span style={dotStyle(1)} /><span style={dotStyle(2)} />
            <span>Reeve is thinking…</span>
          </div>
        )}
      </div>

      {/* ─── Suggestion chips (above composer) ─── */}
      <div style={{ maxWidth: "820px", width: "100%", margin: "0 auto", padding: "0 20px 8px", display: "flex", flexWrap: "wrap", gap: "8px", flexShrink: 0 }}>
        {SUGGESTIONS.map((s) => (
          <button key={s.label} onClick={() => send(s.message)} disabled={isThinking} style={chipStyle}>{s.label}</button>
        ))}
      </div>

      {/* ─── Composer ─── */}
      <div style={{ maxWidth: "820px", width: "100%", margin: "0 auto", padding: "12px 20px 20px", borderTop: "1px solid #f0f0f0", flexShrink: 0 }}>
        <div style={{ display: "flex", gap: "10px", alignItems: "flex-end", background: "#f6f6f7", border: "1px solid #e1e1e1", borderRadius: "12px", padding: "8px" }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }}
            placeholder="Ask Reeve about your inventory…  (Enter to send)"
            rows={1}
            style={{ flex: 1, resize: "none", border: "none", background: "transparent", fontSize: "15px", fontFamily: "inherit", outline: "none", maxHeight: "120px", lineHeight: 1.5 }}
          />
          <button
            onClick={() => send(input)}
            disabled={!input.trim() || isThinking}
            style={{
              background: input.trim() && !isThinking ? "#000" : "#ccc",
              color: "#FFD60A", border: "none", borderRadius: "8px",
              padding: "0 16px", height: "38px",
              cursor: input.trim() && !isThinking ? "pointer" : "default",
              fontWeight: 600, fontSize: "14px", flexShrink: 0,
            }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const SUGGESTIONS = [
  { label: "What's running low?", message: "What's running low?" },
  { label: "Summarize my inventory", message: "Summarize my inventory health" },
  { label: "Show my products", message: "Show me my products" },
  { label: "Mark out-of-stock items unavailable", message: "Find out-of-stock items and mark them as DRAFT/unavailable" },
];

function WelcomeCard({ summary }: { summary: InventorySummary }) {
  return (
    <div style={{ textAlign: "center", padding: "40px 20px 32px" }}>
      <div style={{ width: "56px", height: "56px", borderRadius: "50%", background: "#000", color: "#FFD60A", display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: "26px", marginBottom: "16px" }}>R</div>
      <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "0 0 8px" }}>Reeve AI</h1>
      <p style={{ fontSize: "15px", color: "#666", margin: "0 0 24px", maxWidth: "440px", marginLeft: "auto", marginRight: "auto" }}>
        Your Shopify inventory intern. Ask me what's running low, have me restock items, update prices, or mark products unavailable — I'll act on your store directly.
      </p>
      {summary.total > 0 && (
        <div style={{ display: "flex", gap: "12px", justifyContent: "center", flexWrap: "wrap" }}>
          <SummaryPill label="Products" value={summary.total} />
          <SummaryPill label="Low stock" value={summary.lowStock} tone="#B86E00" />
          <SummaryPill label="Out of stock" value={summary.outOfStock} tone="#D72C0D" />
        </div>
      )}
    </div>
  );
}

function SummaryPill({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div style={{ background: "#f6f6f7", border: "1px solid #e1e1e1", borderRadius: "10px", padding: "10px 18px", minWidth: "90px" }}>
      <div style={{ fontSize: "22px", fontWeight: 700, color: tone ?? "#000" }}>{value}</div>
      <div style={{ fontSize: "11px", color: "#666", textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</div>
    </div>
  );
}

function MessageBubble({ msg }: { msg: Message }) {
  const isUser = msg.role === "user";
  return (
    <div style={{ marginBottom: "20px", display: "flex", gap: "12px", flexDirection: isUser ? "row-reverse" : "row" }}>
      {/* Avatar */}
      <div style={{
        width: "32px", height: "32px", borderRadius: "50%", flexShrink: 0,
        background: isUser ? "#444" : "#000", color: isUser ? "#fff" : "#FFD60A",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontWeight: 700, fontSize: "13px",
      }}>
        {isUser ? "You" : "R"}
      </div>
      {/* Bubble + actions */}
      <div style={{ maxWidth: "75%" }}>
        <div style={{
          padding: "12px 16px", borderRadius: isUser ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
          background: isUser ? "#000" : "#f6f6f7", color: isUser ? "#fff" : "#000",
          fontSize: "14px", lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>
          {msg.content}
        </div>
        {msg.actions && msg.actions.length > 0 && (
          <div style={{ marginTop: "8px", display: "flex", flexDirection: "column", gap: "6px" }}>
            {msg.actions.map((a, i) => (
              <div key={i} style={{
                border: "1px solid", borderRadius: "8px", padding: "8px 12px", fontSize: "12px",
                background: a.ok ? "#fff" : "#FFF5F5", borderColor: a.ok ? "#e1e1e1" : "#FFCACA",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <span style={{ color: a.ok ? "#008060" : "#D72C0D", fontWeight: 700 }}>{a.ok ? "✓" : "✗"}</span>
                  <span style={{ fontWeight: 600 }}>{a.summary}</span>
                </div>
                {a.error && <div style={{ color: "#D72C0D", marginTop: "2px", fontSize: "11px" }}>{a.error}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const chipStyle: React.CSSProperties = {
  border: "1px solid #e1e1e1", background: "#fff", borderRadius: "999px",
  padding: "6px 14px", fontSize: "13px", color: "#444", cursor: "pointer",
};
function dotStyle(delay: number): React.CSSProperties {
  return { display: "inline-block", width: "7px", height: "7px", borderRadius: "50%", background: "#999", animation: "reeveBounce 1s infinite", animationDelay: `${delay * 0.15}s` };
}

export const links = () => [
  { rel: "stylesheet", href: "data:text/css," + encodeURIComponent("@keyframes reeveBounce{0%,80%,100%{transform:scale(0.6);opacity:0.5}40%{transform:scale(1);opacity:1}}") },
];

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
