// app/routes/app._index.tsx — Reeve AI as a FULL-PAGE chat.
//
// Gemini-style redesign: white page, near-black text, grey surfaces, blue
// accent. No header bar — just a tiny corner pill. No avatars, no bubbles
// on the assistant side. Suggestion chips shown only on the empty homepage.
//
// Custom-element rule: Polaris web components only for static display. The
// chat (textarea, send button, message rows, chips) is plain native DOM with
// standard React controlled binding. The backend (loader, send, fetcher,
// chat route, agent, tools, audit) is untouched — only the visual layer.

import { useEffect, useRef, useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";

// ─── Color tokens (single source of truth) ─────────────────────────────────
const C = {
  bg: "#FFFFFF",
  textPrimary: "#1F1F1F",
  textMuted: "#5F6368",
  surface: "#F0F0F0", // user bubbles, chips
  surface2: "#F8F9FA", // thinking bg
  border: "#E5E5E5",
  accentBlue: "#1A73E8", // send button, focus ring, success ticks
  dangerRed: "#D93025", // error ticks
  okGreen: "#1E8E3E", // alt success accent
} as const;

const CONTENT_MAX = 720; // px — Gemini's content width feel

// ─── Loader (unchanged) ──────────────────────────────────────────────────────

interface InventorySummary { total: number; inStock: number; lowStock: number; outOfStock: number; topLow: { id: string; title: string; inventory: number }[] }
interface ChatAction { name: string; summary: string; ok: boolean; error?: string }
interface Message {
  id: string;
  role: string;
  content: string;
  actions: ChatAction[] | null;
  reasoning?: string | null; // assistant only; null for user + legacy rows
  elapsedMs?: number | null; // assistant only; null for user + legacy rows
}
interface LoaderData { summary: InventorySummary; messages: Message[]; provider: "nvidia" | "demo" }

/** Shape returned by POST /app/chat — used by the optimistic assistant-reply effect. */
interface ChatResult { response?: string; reasoning?: string | null; actions?: ChatAction[]; elapsedMs?: number | null; error?: string }

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
      reasoning: m.reasoning ?? null,
      elapsedMs: m.elapsedMs ?? null,
      actions: m.actionsJson ? (JSON.parse(m.actionsJson) as ChatAction[]) : null,
    })),
    provider: process.env.NVIDIA_API_KEY ? "nvidia" : "demo",
  };
};

// ─── Full-page chat ─────────────────────────────────────────────────────────

export default function ReeveChat() {
  const { summary, messages: initialMessages, provider } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof loader>();
  const chatFetcher = useFetcher<ChatResult>();
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
          content: chatFetcher.data.response!,
          reasoning: chatFetcher.data.reasoning ?? null,
          elapsedMs: chatFetcher.data.elapsedMs ?? null,
          actions: chatFetcher.data.actions ?? null,
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

  const empty = messages.length === 0;

  return (
    <div style={{ position: "relative", display: "flex", flexDirection: "column", height: "100vh", maxHeight: "100vh", background: C.bg, fontFamily: '"Inter", system-ui, -apple-system, sans-serif' }}>

      {/* ─── Corner pill (replaces header bar) ─── */}
      <div style={{ position: "absolute", top: "16px", left: "20px", display: "flex", alignItems: "center", gap: "10px", pointerEvents: "none", zIndex: 5 }}>
        <span style={{ fontSize: "15px", fontWeight: 500, color: C.textPrimary, letterSpacing: "-0.01em" }}>Reeve</span>
        <span style={{
          display: "inline-flex", alignItems: "center", gap: "5px",
          padding: "2px 9px", borderRadius: "999px", fontSize: "11px", fontWeight: 500,
          background: provider === "nvidia" ? "rgba(26,115,232,0.10)" : C.surface,
          color: provider === "nvidia" ? C.accentBlue : C.textMuted,
        }}>
          <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: provider === "nvidia" ? C.accentBlue : C.textMuted }} />
          {provider === "nvidia" ? "Live AI" : "Demo"}
        </span>
      </div>

      {/* ─── Messages (or homepage empty state) ─── */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: empty ? "0 24px" : "72px 24px 24px", maxWidth: `${CONTENT_MAX}px`, width: "100%", margin: "0 auto", boxSizing: "border-box" }}>
        {empty ? (
          <WelcomeHome summary={summary} onPick={(text) => send(text)} disabled={isThinking} />
        ) : (
          <>
            {messages.map((m) => <MessageRow key={m.id} msg={m} />)}
            {isThinking && (
              <div style={{ display: "flex", gap: "8px", alignItems: "center", padding: "10px 0", marginLeft: "2px" }}>
                <span style={{ fontSize: "13px", color: C.textMuted }}>Thinking</span>
                <span style={thinkingDot(0)} />
                <span style={thinkingDot(1)} />
                <span style={thinkingDot(2)} />
              </div>
            )}
          </>
        )}
      </div>

      {/* ─── Composer ─── */}
      <div style={{ maxWidth: `${CONTENT_MAX}px`, width: "100%", margin: "0 auto", padding: "8px 24px 24px", boxSizing: "border-box", flexShrink: 0 }}>
        <div
          style={{
            display: "flex", alignItems: "flex-end", gap: "8px",
            background: C.bg, border: `1px solid ${C.border}`, borderRadius: "24px",
            padding: "8px 8px 8px 18px", boxShadow: "0 1px 6px rgba(60,64,67,0.08)",
            transition: "box-shadow 0.15s ease, border-color 0.15s ease",
          }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            placeholder="Ask Reeve about your inventory…  (Enter to send, Shift+Enter for newline)"
            rows={1}
            style={{
              flex: 1, resize: "none", border: "none", background: "transparent",
              fontSize: "15px", lineHeight: 1.5, color: C.textPrimary,
              fontFamily: "inherit", outline: "none", maxHeight: "160px", padding: "6px 0",
            }}
          />
          <SendButton active={!!input.trim() && !isThinking} onClick={() => send(input)} disabled={!input.trim() || isThinking} />
        </div>
        <p style={{ textAlign: "center", color: C.textMuted, fontSize: "11px", margin: "8px 0 0" }}>
          Reeve can act on your store — review suggested actions before confirming.
        </p>
      </div>
    </div>
  );
}

// ─── Homepage empty state ───────────────────────────────────────────────────

const SUGGESTIONS = [
  { label: "What's running low?", message: "What's running low?" },
  { label: "Summarize my inventory", message: "Summarize my inventory health" },
  { label: "Show my products", message: "Show me my products" },
  { label: "Mark out-of-stock unavailable", message: "Find out-of-stock items and mark them as DRAFT/unavailable" },
];

function WelcomeHome({ summary, onPick, disabled }: { summary: InventorySummary; onPick: (text: string) => void; disabled: boolean }) {
  return (
    <div style={{ minHeight: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "32px 0", textAlign: "center" }}>
      <h1 style={{ fontSize: "40px", fontWeight: 500, letterSpacing: "-0.02em", color: C.textPrimary, margin: "0 0 12px" }}>
        Hello, Omar
      </h1>
      <p style={{ fontSize: "16px", color: C.textMuted, margin: "0 0 32px", maxWidth: "440px" }}>
        Ask Reeve about your inventory — what's low, restock, update prices, or mark products unavailable.
      </p>

      {summary.total > 0 && (
        <div style={{ display: "flex", gap: "10px", justifyContent: "center", flexWrap: "wrap", marginBottom: "28px" }}>
          <StatChip label="Products" value={summary.total} />
          <StatChip label="In stock" value={summary.inStock} tone={C.okGreen} />
          <StatChip label="Low stock" value={summary.lowStock} tone={C.accentBlue} />
          <StatChip label="Out of stock" value={summary.outOfStock} tone={C.dangerRed} />
        </div>
      )}

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "center", maxWidth: "560px" }}>
        {SUGGESTIONS.map((s) => (
          <button
            key={s.label}
            onClick={() => onPick(s.message)}
            disabled={disabled}
            style={{
              border: `1px solid ${C.border}`, background: C.bg, borderRadius: "999px",
              padding: "9px 16px", fontSize: "13px", color: C.textPrimary, cursor: disabled ? "default" : "pointer",
              fontFamily: "inherit", transition: "background 0.12s ease",
            }}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function StatChip({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div style={{
      background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "10px",
      padding: "8px 16px", minWidth: "84px",
    }}>
      <div style={{ fontSize: "20px", fontWeight: 600, color: tone ?? C.textPrimary, lineHeight: 1.2 }}>{value}</div>
      <div style={{ fontSize: "10px", color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.05em", marginTop: "2px" }}>{label}</div>
    </div>
  );
}

// ─── Chat messages ──────────────────────────────────────────────────────────

function MessageRow({ msg }: { msg: Message }) {
  const isUser = msg.role === "user";
  if (isUser) {
    return (
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "18px" }}>
        <div style={{
          maxWidth: "78%", padding: "10px 16px",
          background: C.surface, color: C.textPrimary,
          borderRadius: "16px", fontSize: "14px", lineHeight: 1.6,
          whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>
          {msg.content}
        </div>
      </div>
    );
  }
  return (
    <div style={{ marginBottom: "22px" }}>
      {msg.reasoning && msg.reasoning.trim() && <ReasoningChip reasoning={msg.reasoning} elapsedMs={msg.elapsedMs} />}
      <div style={{ fontSize: "14px", lineHeight: 1.7, color: C.textPrimary, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {msg.content}
      </div>
      {msg.actions && msg.actions.length > 0 && (
        <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "6px" }}>
          {msg.actions.map((a, i) => <ActionCard key={i} action={a} />)}
        </div>
      )}
    </div>
  );
}

/** Collapsible "Thought for Ns" chip — ChatGPT/Claude pattern. */
function ReasoningChip({ reasoning, elapsedMs }: { reasoning: string; elapsedMs?: number | null }) {
  const [open, setOpen] = useState(false);
  const seconds = elapsedMs != null ? Math.max(1, Math.round(elapsedMs / 1000)) : null;
  const label = seconds != null ? `Thought for ${seconds}s` : "Reasoning";
  return (
    <div style={{ marginBottom: "10px" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "inline-flex", alignItems: "center", gap: "6px",
          border: "none", background: "transparent", cursor: "pointer",
          fontFamily: "inherit", fontSize: "12px", color: C.textMuted,
          padding: "2px 0",
        }}
      >
        <span style={{ fontSize: "12px", lineHeight: 1, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s ease", display: "inline-block" }}>{">"}</span>
        <span>{label}</span>
      </button>
      {open && (
        <div style={{
          marginTop: "6px", padding: "10px 12px",
          background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "8px",
          fontSize: "12px", lineHeight: 1.6, color: C.textMuted,
          whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>
          {reasoning}
        </div>
      )}
    </div>
  );
}

function ActionCard({ action: a }: { action: ChatAction }) {
  const color = a.ok ? C.accentBlue : C.dangerRed;
  return (
    <div style={{
      border: `1px solid ${C.border}`, borderRadius: "8px",
      padding: "8px 12px", background: C.bg, fontSize: "12px",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span style={{ color, fontWeight: 700, fontSize: "13px" }}>{a.ok ? "✓" : "✗"}</span>
        <span style={{ fontWeight: 500, color: C.textPrimary }}>{a.summary}</span>
      </div>
      {a.error && <div style={{ color: C.dangerRed, marginTop: "3px", fontSize: "11px" }}>{a.error}</div>}
    </div>
  );
}

// ─── Composer pieces ────────────────────────────────────────────────────────

function SendButton({ active, onClick, disabled }: { active: boolean; onClick: () => void; disabled: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label="Send message"
      style={{
        width: "36px", height: "36px", borderRadius: "50%",
        border: "none", flexShrink: 0,
        background: active ? C.accentBlue : C.border,
        color: "#fff", cursor: disabled ? "default" : "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: "18px", fontWeight: 700, lineHeight: 1,
        transition: "background 0.15s ease",
      }}
    >
      ↑
    </button>
  );
}

function thinkingDot(delay: number): React.CSSProperties {
  return {
    display: "inline-block", width: "7px", height: "7px", borderRadius: "50%",
    background: C.textMuted, opacity: 0.6,
    animation: "reevePulse 1.2s ease-in-out infinite", animationDelay: `${delay * 0.18}s`,
  };
}

// ─── Per-route CSS (keyframes only) + headers ────────────────────────────

export const links = () => [
  {
    rel: "stylesheet",
    href: "data:text/css," + encodeURIComponent(
      "@keyframes reevePulse{0%,100%{opacity:0.25;transform:scale(0.85)}50%{opacity:0.9;transform:scale(1)}}",
    ),
  },
];

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
