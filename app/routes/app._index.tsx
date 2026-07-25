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
import type { ReasoningEffort } from "../lib/llm.server";

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
  const [effort, setEffort] = useState<ReasoningEffort>("medium");
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastReplyRef = useRef<string | null>(null);

  // Session-persist the reasoning-effort choice (until the Conversation model lands,
  // this is global per-browser; per-chat persistence follows in the next commit).
  useEffect(() => {
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem("reeve.effort") : null;
    if (saved === "medium" || saved === "high" || saved === "max") setEffort(saved);
  }, []);
  useEffect(() => {
    try { localStorage.setItem("reeve.effort", effort); } catch { /* ignore */ }
  }, [effort]);

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
    chatFetcher.submit({ message: trimmed, effort }, { method: "POST", action: "/app/chat", encType: "application/json" });
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
      <div style={{ position: "absolute", top: "14px", left: "20px", right: "20px", display: "flex", alignItems: "center", gap: "10px", zIndex: 5 }}>
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
        <div style={{ marginLeft: "auto" }}>
          <EffortDropdown value={effort} onChange={setEffort} disabled={isThinking} />
        </div>
      </div>

      {/* ─── Messages (or homepage empty state) ─── */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: empty ? "0 24px" : "72px 24px 24px", maxWidth: `${CONTENT_MAX}px`, width: "100%", margin: "0 auto", boxSizing: "border-box" }}>
        {empty ? (
          <WelcomeHome summary={summary} onPick={(text) => send(text)} disabled={isThinking} />
        ) : (
          <>
            {messages.map((m) => <MessageRow key={m.id} msg={m} />)}
            {isThinking && (
              <div style={{ display: "flex", gap: "12px", alignItems: "center", padding: "10px 0 12px" }}>
                <ReeveThinkingIcon size={36} />
                <span style={{ fontSize: "13px", color: C.textMuted, fontWeight: 500 }}>Thinking</span>
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
      <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
        <div style={{ flexShrink: 0, paddingTop: "2px" }}>
          <ReeveIcon cardColor={C.textPrimary} size={36} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {msg.reasoning && msg.reasoning.trim() && <ReasoningChip reasoning={msg.reasoning} elapsedMs={msg.elapsedMs} />}
          <div style={{ fontSize: "14px", lineHeight: 1.7, color: C.textPrimary, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {msg.content}
          </div>
        </div>
      </div>
      {msg.actions && msg.actions.length > 0 && (
        <div style={{ marginTop: "10px", marginLeft: "28px", display: "flex", flexDirection: "column", gap: "6px" }}>
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
          fontFamily: "inherit", fontSize: "12px", fontWeight: 500, color: C.textMuted,
          padding: "4px 0", userSelect: "none",
        }}
      >
        <span style={{ fontSize: "12px", lineHeight: 1, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s ease", display: "inline-block" }}>{">"}</span>
        <span>{label}</span>
      </button>
      {open && (
        <div style={{
          marginTop: "8px", padding: "12px 14px",
          background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "10px",
          fontSize: "13px", lineHeight: 1.65, color: C.textMuted, fontStyle: "italic",
          whiteSpace: "pre-wrap", wordBreak: "break-word",
          boxShadow: "inset 0 0 0 0 transparent",
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

const EFFORTS: { value: ReasoningEffort; label: string; hint: string }[] = [
  { value: "medium", label: "Thinking: Medium", hint: "Fast — balanced reasoning + answer" },
  { value: "high", label: "Thinking: High", hint: "Deeper reasoning, slower" },
  { value: "max", label: "Thinking: Max", hint: "Deepest reasoning + larger answer budget" },
];

function EffortDropdown({ value, onChange, disabled }: { value: ReasoningEffort; onChange: (e: ReasoningEffort) => void; disabled: boolean }) {
  return (
    <label style={{
      display: "inline-flex", alignItems: "center", gap: "6px",
      fontSize: "11px", fontWeight: 500, color: C.textMuted,
      background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "999px",
      padding: "3px 10px 3px 12px", cursor: disabled ? "default" : "pointer", userSelect: "none",
    }}>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as ReasoningEffort)}
        title={EFFORTS.find((x) => x.value === value)?.hint ?? ""}
        style={{
          border: "none", background: "transparent", fontFamily: "inherit",
          fontSize: "11px", fontWeight: 500, color: C.textMuted,
          outline: "none", cursor: disabled ? "default" : "pointer", padding: 0,
        }}
      >
        {EFFORTS.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
      </select>
    </label>
  );
}

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

// ─── Reeve brand icon (rounded-square card + inverted R silhouette) ─────────
// Card color follows `cardColor`; the R silhouette stays white. Pass muted grey
// while the agent is generating, full black once the reply has landed.
function ReeveIcon({ cardColor = "#1F1F1F", size = 36 }: { cardColor?: string; size?: number }) {
  // Only the R glyph is rendered — no rounded-square card behind it. cardColor
  // controls the R fill (muted grey during generation, near-black when done).
  const h = Math.round((size * 1038) / 1156);
  return (
    <svg viewBox="0 0 1156 1038" width={size} height={h} aria-hidden style={{ display: "block", overflow: "visible" }}>
      <path
        d="M708.61 598.5C749.37 658.5 790.13 718.5 830.89 778.5C821.99 780.73 808.93 779.1 799.5 779.08C778.5 779.05 757.5 779.04 736.5 779.05C728.83 779.06 721.17 779.01 713.5 779.05C710.43 779.07 705.76 779.96 702.98 778.51C701.2 777.58 700.3 774.85 699.28 773.25C696.56 768.97 693.81 764.73 691.02 760.51C680.53 744.62 670.31 728.57 659.83 712.69C630.66 668.48 601.69 624.11 572.76 579.74C563.41 565.4 553.98 551.14 544.74 536.75C541.13 531.12 535.57 525.12 533.5 518.84C537.01 518.05 540.85 518.83 544.5 518.86C551.16 518.92 557.84 518.81 564.5 518.76C577.83 518.67 591.17 518.49 604.5 518.46C640.09 518.35 676.72 516.65 695.44 480.92C698.74 474.61 700.81 467.49 702.06 460.5C703.84 450.5 703.59 439.63 701.71 429.66C700.5 423.22 698.85 416.56 695.71 410.76C672.43 367.84 616.85 373.85 575.5 373.86C565.5 373.86 555.5 373.86 545.5 373.87C532.17 373.88 518.83 373.9 505.5 373.93C498.51 373.94 490.75 373.09 483.96 374.5C498.76 457.5 513.55 540.5 528.35 623.5C503.4 622.71 478.45 621.92 453.5 621.13C465.83 725.93 478.17 830.72 490.5 935.52C487.23 934.77 486.79 932.26 485.5 929C483.07 922.82 480.56 916.7 477.87 910.62C466.76 885.44 455.61 860.25 444.4 835.12C411.88 762.25 379.76 689.18 347.17 616.34C336.85 593.29 326.66 570.22 316.35 547.2C311.98 537.46 308.62 526.69 303.21 517.5C309.25 516.6 316.35 518.2 322.5 518.82C335.84 520.17 349.13 521.95 362.46 523.33C368.67 523.98 377.66 526.89 383.5 524.93C382.87 520.05 381.17 515.25 380.31 510.37C378.02 497.31 374.87 484.41 372.26 471.42C363.94 429.84 354.48 388.46 346.58 346.8C343.78 332.08 340.54 317.44 337.64 302.73C335.79 293.31 332.33 283.24 332.5 273.65C339.76 273.08 347.21 273.43 354.5 273.33C372.16 273.06 389.83 273.03 407.5 272.86C458.16 272.39 508.83 272.39 559.5 272.38C616.27 272.36 677.14 268.21 729.59 293.87C761.57 309.52 790.18 336.36 803.57 369.89C813.36 394.4 816.31 420.25 815.98 446.5C815.62 475.44 809.78 504.97 794.34 529.82C780.63 551.88 760.12 571.17 737.75 584.27C728.35 589.78 718.13 593.37 708.61 598.5Z"
        fill={cardColor}
      />
    </svg>
  );
}

/** Thinking-row icon: muted-grey R glyph + a horizontal light sweep that plays
 *  only while the agent is generating. The sweep is a thin translucent white
 *  bar that travels left-to-right across the R glyph. */
function ReeveThinkingIcon({ size = 36 }: { size?: number }) {
  return (
    <div style={{ position: "relative", width: `${size}px`, height: `${Math.round((size * 1038) / 1156)}px`, overflow: "hidden", borderRadius: "3px", flexShrink: 0 }}>
      <ReeveIcon cardColor={C.textMuted} size={size} />
      <div
        style={{
          position: "absolute", top: 0, left: 0, height: "100%", width: "40%",
          background: "linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.55) 50%, rgba(255,255,255,0) 100%)",
          animation: "reeveSweep 1.6s ease-in-out infinite",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}

// ─── Per-route CSS (keyframes only) + headers ────────────────────────────

export const links = () => [
  {
    rel: "stylesheet",
    href: "data:text/css," + encodeURIComponent(
      "@keyframes reevePulse{0%,100%{opacity:0.25;transform:scale(0.85)}50%{opacity:0.9;transform:scale(1)}}" +
      "@keyframes reeveSweep{0%{transform:translateX(-120%)}100%{transform:translateX(280%)}}",
    ),
  },
];

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
