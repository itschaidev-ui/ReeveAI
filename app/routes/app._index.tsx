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

// Approval-word detection. When the user replies to a pending-write turn with
// one of these, we intercept the input and route it to /app/chat/approve
// instead of /app/chat. Lets merchants type "yes" instead of hunting for the
// Approve button.
const APPROVAL_YES = /^\s*(yes|y|yep|yeah|ok|okay|sure|approve|approved|confirm|confirmed|do it|go ahead|go for it|please do|do that)\s*[!.]?\s*$/i;
const APPROVAL_NO = /^\s*(no|n|nope|cancel|cancelled|cancel it|dont|do not|stop|abort)\s*[!.]?\s*$/i;

// ─── Loader (unchanged) ──────────────────────────────────────────────────────

interface InventorySummary { total: number; inStock: number; lowStock: number; outOfStock: number; topLow: { id: string; title: string; inventory: number }[] }
interface ChatAction { name: string; summary: string; ok: boolean; error?: string; result?: unknown }
interface PendingWrite {
  nonce: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
}

interface Message {
  id: string;
  role: string;
  content: string;
  actions: ChatAction[] | null;
  reasoning?: string | null; // assistant only; null for user + legacy rows
  elapsedMs?: number | null; // assistant only; null for user + legacy rows
  pendingWrites?: PendingWrite[]; // assistant only; transient (not persisted yet)
}
interface LoaderData { summary: InventorySummary; messages: Message[]; provider: "nvidia" | "demo" }

/** Shape returned by POST /app/chat — used by the optimistic assistant-reply effect. */
interface ChatResult { response?: string; reasoning?: string | null; actions?: ChatAction[]; elapsedMs?: number | null; pendingWrites?: PendingWrite[]; error?: string }

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
  const approveFetcher = useFetcher<{ action?: ChatAction; error?: string }>();
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

  // When the loader refreshes (after a reply lands), MERGE its DB-persisted
  // messages with our in-flight optimistic state instead of blindly replacing.
  // This preserves pendingWrites (which are NOT persisted to the DB yet) so the
  // Approve cards survive the refresh. Without this, the loader data wipes them
  // and the Approve button disappears immediately after it should appear.
  useEffect(() => {
    if (!fetcher.data?.messages) return;
    setMessages((current) => {
      const fresh = fetcher.data!.messages!;
      // Index fresh DB messages by content so we can match optimistic rows.
      const byContent = new Map<string, Message>();
      for (const m of fresh) byContent.set(m.content, m);
      const merged: Message[] = [];
      const seenContents = new Set<string>();
      for (const m of current) {
        const dbMatch = byContent.get(m.content);
        if (dbMatch) {
          // DB row exists for this content. Preserve any pendingWrites the
          // optimistic version had (DB does not persist them).
          merged.push({ ...dbMatch, pendingWrites: m.pendingWrites ?? dbMatch.pendingWrites });
          seenContents.add(m.content);
        } else if (m.id.startsWith("u-") || m.id.startsWith("a-")) {
          // Pure optimistic row (not yet in DB). Keep it as-is.
          merged.push(m);
          seenContents.add(m.content);
        }
      }
      // Append any DB rows that arrived after our optimistic tail (e.g. an
      // assistant message whose persist completed but whose optimistic copy
      // was already replaced).
      for (const m of fresh) {
        if (!seenContents.has(m.content)) merged.push(m);
      }
      return merged;
    });
  }, [fetcher.data]);

  // Listen for the "reeve:stub" events dispatched by the alert-card buttons.
  // Until those buttons get real handlers in the conversations commit, give
  // the user honest feedback ("coming soon") instead of letting them look dead.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      shopify.toast.show(`${detail}: coming soon`, { duration: 2500 });
    };
    window.addEventListener("reeve:stub", handler as EventListener);
    return () => window.removeEventListener("reeve:stub", handler as EventListener);
  }, [shopify]);

  // Bridge from the PendingWriteCard's Approve click to approveFetcher.submit.
  // We do it via window events so the card stays a self-contained component
  // and doesn't need approveFetcher props plumbed through.
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent<{ messageId: string; nonce: string; tool: string; args: Record<string, unknown> }>).detail;
      approveFetcherRef.current = { messageId: d.messageId, nonce: d.nonce };
      approveFetcher.submit(
        { tool: d.tool, args: d.args },
        { method: "POST", action: "/app/chat/approve", encType: "application/json" },
      );
      // Let the card know its click has been accepted.
      window.dispatchEvent(new CustomEvent("reeve:approve-resolved", { detail: { nonce: d.nonce } }));
    };
    window.addEventListener("reeve:approve", handler as EventListener);
    return () => window.removeEventListener("reeve:approve", handler as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, chatFetcher.state]);

  const isThinking = chatFetcher.state !== "idle";

  /** Resolve a pending write by either removing it (cancel) or replacing it
   *  with the action returned by /app/chat/approve. Called by PendingWriteCard. */
  const resolveWrite = (params: { messageId: string; nonce: string; action?: ChatAction }) => {
    setMessages((ms) =>
      ms.map((m) => {
        if (m.id !== params.messageId) return m;
        const remaining = (m.pendingWrites ?? []).filter((p) => p.nonce !== params.nonce);
        const actions = params.action ? [...(m.actions ?? []), params.action] : (m.actions ?? []);
        return { ...m, pendingWrites: remaining, actions };
      }),
    );
    if (params.action) {
      shopify.toast.show(params.action.ok ? "Approved — done" : "Write failed", { isError: !params.action.ok });
    }
  };

  // Drain approve fetcher results back into the message list.
  useEffect(() => {
    if (approveFetcher.state === "idle" && approveFetcher.data) {
      const meta = approveFetcherRef.current;
      if (meta) {
        resolveWrite({ messageId: meta.messageId, nonce: meta.nonce, action: approveFetcher.data.action });
        if (approveFetcher.data.error) shopify.toast.show(approveFetcher.data.error, { isError: true });
        approveFetcherRef.current = null;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approveFetcher.data, approveFetcher.state]);

  // Track which pending write is in-flight so we know where to slot the result.
  const approveFetcherRef = useRef<{ messageId: string; nonce: string } | null>(null);

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isThinking) return;

    // Approval intercept: if the user typed a yes-word and the latest assistant
    // message has pending writes, route the input to /app/chat/approve for each
    // pending write instead of /app/chat. This handles the natural "Yes" reply
    // to "Do you approve this change?" without requiring the merchant to find
    // the Approve button.
    const latestAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    const pendingOnLatest = latestAssistant?.pendingWrites?.filter((p) => p && p.nonce) ?? [];
    if (pendingOnLatest.length > 0) {
      if (APPROVAL_YES.test(trimmed.toLowerCase())) {
        setMessages((m) => [...m, { id: `u-${Date.now()}`, role: "user", content: trimmed }]);
        setInput("");
        for (const pw of pendingOnLatest) {
          window.dispatchEvent(new CustomEvent("reeve:approve", {
            detail: { messageId: latestAssistant!.id, nonce: pw.nonce, tool: pw.tool, args: pw.args },
          }));
        }
        return;
      }
      if (APPROVAL_NO.test(trimmed.toLowerCase())) {
        setMessages((m) => [...m, { id: `u-${Date.now()}`, role: "user", content: trimmed }]);
        setInput("");
        setMessages((ms) => ms.map((m) =>
          m.id === latestAssistant!.id ? { ...m, pendingWrites: [] } : m,
        ));
        shopify.toast.show("Cancelled pending write(s)");
        return;
      }
    }

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
          pendingWrites: chatFetcher.data.pendingWrites ?? [],
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
            {messages.map((m) => <MessageRow key={m.id} msg={m} resolveWrite={resolveWrite} />)}
            {isThinking && (
              <ThinkingRow />
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
            placeholder={composerPlaceholder({ summary, messages, isThinking })}
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
        {greetingHeadline(summary)}
      </h1>
      <p style={{ fontSize: "16px", color: C.textMuted, margin: "0 0 32px", maxWidth: "460px" }}>
        {greetingSubline(summary)}
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

function MessageRow({ msg, resolveWrite }: { msg: Message; resolveWrite: (params: { messageId: string; nonce: string; action?: ChatAction }) => void }) {
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
      {msg.pendingWrites && msg.pendingWrites.length > 0 && (
        <div style={{ marginTop: "10px", marginLeft: "28px", display: "flex", flexDirection: "column", gap: "8px" }}>
          {msg.pendingWrites.map((pw) => (
            <PendingWriteCard key={pw.nonce} messageId={msg.id} write={pw} onResolved={resolveWrite} />
          ))}
        </div>
      )}
      {msg.actions && msg.actions.length > 0 && (
        <div style={{ marginTop: "10px", marginLeft: "28px", display: "flex", flexDirection: "column", gap: "6px" }}>
          {msg.actions.map((a, i) => <ActionCard key={i} action={a} />)}
        </div>
      )}
    </div>
  );
}

/** Collapsible "Thought for Ns" chip — exposes the agent's reasoning as
 *  numbered, monospaced steps in a light-grey panel (Gemini-style). */
function ReasoningChip({ reasoning, elapsedMs }: { reasoning: string; elapsedMs?: number | null }) {
  const [open, setOpen] = useState(false);
  const seconds = elapsedMs != null ? Math.max(1, Math.round(elapsedMs / 1000)) : null;
  const title = seconds != null ? `Thought for ${seconds}s` : "Thought Process";
  const steps = parseReasoningSteps(reasoning);

  const btnStyle: React.CSSProperties = {
    display: "inline-flex", alignItems: "center", gap: "8px",
    border: "none", background: "transparent", cursor: "pointer",
    fontFamily: "inherit", fontSize: "13px", color: C.textMuted,
    padding: "4px 0", userSelect: "none",
    transition: "color 0.15s ease",
  };

  return (
    <div style={{ marginBottom: "12px" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={btnStyle}
        onMouseEnter={(e) => (e.currentTarget.style.color = C.textPrimary)}
        onMouseLeave={(e) => (e.currentTarget.style.color = C.textMuted)}
      >
        <span>{title}</span>
        <ChevronDownIcon size={14} open={open} />
      </button>

      {open && (
        steps.length > 0 ? (
          <ol style={{
            marginTop: "10px", marginBottom: 0, paddingLeft: "16px", listStyle: "none",
            borderLeft: `1px solid ${C.border}`, marginLeft: "6px",
            display: "flex", flexDirection: "column", gap: "8px",
            fontSize: "13px", lineHeight: 1.6, color: C.textMuted,
          }}>
            {steps.map((step, i) => (
              <li key={i}>
                <span>
                  {i + 1}.{" "}
                  {step.label && <span style={{ fontWeight: 600, color: C.textPrimary }}>{step.label}</span>}
                  {step.label && step.detail ? ": " : ""}
                  {step.detail}
                </span>
                {step.children && step.children.length > 0 && (
                  <ul style={{
                    marginTop: "4px", marginLeft: "16px", paddingLeft: "16px",
                    listStyleType: "disc",
                  }}>
                    {step.children.map((child, j) => (
                      <li key={j} style={{ color: C.textMuted }}>{child}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        ) : (
          // Legacy / unparseable reasoning: render raw preformatted.
          <pre style={{
            marginTop: "10px", padding: "12px 14px",
            background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "10px",
            margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word",
            fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
            fontSize: "12.5px", lineHeight: 1.55, color: C.textMuted,
          }}>{reasoning}</pre>
        )
      )}
    </div>
  );
}

/** Parse the reasoning string into structured steps with optional children.
 *
 *  Expected format (produced by the askLlm prompt):
 *    1. Analyze Input — parsing the merchant question
 *    2. Plan Tool Calls — call get_low_stock_products
 *    - Filter by inventory_quantity <= threshold
 *    - Sort ascending
 *
 *  Each top-level numbered line becomes a step. Lines starting with "-" or "*"
 *  that follow a step attach as children of the most recent step. Unnumbered
 *  text falls back to a single step whose label is empty and detail is the line.
 *  Returns [] when the input is empty or no lines are present.
 */
function parseReasoningSteps(reasoning: string): { label: string; detail: string; children?: string[] }[] {
  const lines = reasoning.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];

  const steps: { label: string; detail: string; children?: string[] }[] = [];
  for (const line of lines) {
    const childMatch = line.match(/^[-*]\s+(.+)$/);
    if (childMatch && steps.length > 0) {
      const last = steps[steps.length - 1];
      if (!last.children) last.children = [];
      last.children.push(childMatch[1].trim());
      continue;
    }

    // Try "N. Label - detail" or "N. Label — detail" (em or plain dash).
    const stepMatch = line.match(/^\d{1,2}\.\s+(.+)$/);
    if (stepMatch) {
      const rest = stepMatch[1];
      // Split on em-dash, en-dash, or " - " (but not hyphens inside words).
      const parts = rest.split(/\s+[\u2014\u2013-]\s+/);
      if (parts.length >= 2) {
        steps.push({ label: parts[0].trim(), detail: parts.slice(1).join(" - ").trim() });
      } else {
        // No dash separator: treat whole thing as detail with no label.
        steps.push({ label: "", detail: rest.trim() });
      }
      continue;
    }

    // Unnumbered, non-child line: attach as detail to a new step (no label).
    steps.push({ label: "", detail: line });
  }
  return steps;
}

/** Inline chevron-down icon with rotation when open (matches lucide-react). */
function ChevronDownIcon({ size = 14, open }: { size?: number; open: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden
      style={{
        display: "block", flexShrink: 0,
        transform: open ? "rotate(180deg)" : "none",
        transition: "transform 0.2s ease",
      }}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

type AlertRow = { id: string; title: string; status: string; minInventory: number; variants: { id: string; inventory: number | null }[] };

function ActionCard({ action: a }: { action: ChatAction }) {
  // The InventoryAlertCard is a richer renderer for one specific tool kind;
  // other actions keep the compact summary row.
  if (a.name === "get_low_stock_products" && Array.isArray(a.result) && a.result.length > 0) {
    return <InventoryAlertCard action={a} rows={a.result as AlertRow[]} />;
  }
  return <CompactActionCard action={a} />;
}

function CompactActionCard({ action: a }: { action: ChatAction }) {
  const { statusLabel, statusColor } = actionStatus(a);
  return (
    <div style={{
      border: `1px solid ${C.border}`, borderRadius: "8px",
      padding: "10px 12px", background: C.bg, fontSize: "12px",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span style={{ color: a.ok ? C.accentBlue : C.dangerRed, fontWeight: 700, fontSize: "13px" }}>{a.ok ? "✓" : "✗"}</span>
        <span style={{ fontWeight: 500, color: C.textPrimary, flex: 1 }}>{a.summary}</span>
        {statusLabel && <StatusTag label={statusLabel} color={statusColor} />}
      </div>
      {a.error && <div style={{ color: C.dangerRed, marginTop: "3px", fontSize: "11px" }}>{a.error}</div>}
    </div>
  );
}

function InventoryAlertCard({ action: a, rows }: { action: ChatAction; rows: AlertRow[] }) {
  const lateCount = rows.length;
  return (
    <div style={{
      border: `1px solid ${C.border}`, borderRadius: "10px", background: C.bg,
      boxShadow: "0 1px 3px rgba(60,64,67,0.06)", overflow: "hidden",
    }}>
      <div style={{
        padding: "10px 14px", borderBottom: `1px solid ${C.border}`,
        display: "flex", alignItems: "center", gap: "8px", background: C.surface2,
      }}>
        <span style={{ color: C.dangerRed, fontSize: "14px" }}>{"\u26A0"}</span>
        <span style={{ fontWeight: 600, color: C.textPrimary, fontSize: "13px" }}>
          Low Stock Alert: {lateCount} {lateCount === 1 ? "Product" : "Products"}
        </span>
      </div>
      <div style={{ padding: "6px 0" }}>
        <div style={{
          display: "grid", gridTemplateColumns: "1fr 90px 110px",
          padding: "6px 14px", fontSize: "10px", letterSpacing: "0.04em",
          textTransform: "uppercase", color: C.textMuted, borderBottom: `1px solid ${C.border}`,
        }}>
          <span>Product</span>
          <span style={{ textAlign: "right" }}>Stock</span>
          <span style={{ textAlign: "right" }}>Product ID</span>
        </div>
        {rows.slice(0, 8).map((p) => {
          const stock = p.minInventory;
          const tone = stock <= 0 ? C.dangerRed : stock <= 2 ? "#B45309" : C.textPrimary;
          const status = stock <= 0 ? "Out of stock" : stock <= 2 ? "Critical" : "Low";
          return (
            <div key={p.id} style={{
              display: "grid", gridTemplateColumns: "1fr 90px 110px", alignItems: "center",
              padding: "8px 14px", borderBottom: `1px solid ${C.border}`, fontSize: "12.5px",
            }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
                <span style={{ fontWeight: 500, color: C.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</span>
                <span style={{ fontSize: "10px", color: C.textMuted }}>{status}</span>
              </div>
              <span style={{
                textAlign: "right", fontWeight: 600, color: tone,
                fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', fontSize: "13px",
              }}>{stock}</span>
              <span style={{
                textAlign: "right", color: C.textMuted, fontSize: "10.5px",
                fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
              }}>{p.id.split("/").pop()?.slice(-8)}</span>
            </div>
          );
        })}
        {rows.length > 8 && (
          <div style={{ padding: "6px 14px", fontSize: "11px", color: C.textMuted }}>
            + {rows.length - 8} more
          </div>
        )}
      </div>
      <div style={{ padding: "8px 14px", display: "flex", gap: "8px", flexWrap: "wrap", borderTop: `1px solid ${C.border}`, background: C.surface2 }}>
        <CardButton label="View details" />
        <CardButton label="Set auto-restock" />
        <CardButton label="Export CSV" />
      </div>
    </div>
  );
}

function CardButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        // Stub: wired later with real actions in the conversations commit.
        try { window.dispatchEvent(new CustomEvent("reeve:stub", { detail: label })); } catch { /* ignore */ }
      }}
      style={{
        border: `1px solid ${C.border}`, background: C.bg, color: C.textPrimary,
        borderRadius: "8px", padding: "5px 12px", fontSize: "12px", cursor: "pointer",
        fontFamily: "inherit", fontWeight: 500,
      }}
    >
      {label}
    </button>
  );
}

/** Pending write card. The agent proposed a mutation but did NOT execute it.
 *  Shows the summary + Approve/Cancel. Approve posts to /app/chat/approve;
 *  on response the parent swaps this card for a real action card. */
function PendingWriteCard({ messageId, write, onResolved }: {
  messageId: string;
  write: PendingWrite;
  onResolved: (params: { messageId: string; nonce: string; action?: ChatAction }) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const onApprove = () => {
    if (submitting) return;
    setSubmitting(true);
    // Reuse the approveFetcher. We need to track its target so we know where
    // to slot the result when it lands. Done via approveFetcherRef on the parent.
    window.dispatchEvent(new CustomEvent("reeve:approve", {
      detail: { messageId, nonce: write.nonce, tool: write.tool, args: write.args },
    }));
  };
  useEffect(() => {
    if (!submitting) return;
    // Listen for the parent's resolution broadcast for THIS nonce.
    const handler = (e: Event) => {
      const d = (e as CustomEvent<{ nonce: string }>).detail;
      if (d.nonce === write.nonce) {
        setSubmitting(false);
      }
    };
    window.addEventListener("reeve:approve-resolved", handler as EventListener);
    return () => window.removeEventListener("reeve:approve-resolved", handler as EventListener);
  }, [submitting, write.nonce]);

  return (
    <div style={{
      border: `1px solid ${C.accentBlue}55`, borderRadius: "10px", background: C.bg,
      padding: "10px 12px", boxShadow: "0 1px 3px rgba(26,115,232,0.08)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
        <span style={{ color: C.accentBlue, fontSize: "13px", fontWeight: 700 }}>{"\u270E"}</span>
        <span style={{ fontSize: "11px", fontWeight: 600, color: C.accentBlue, textTransform: "uppercase", letterSpacing: "0.04em" }}>
          Proposed write
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: "10px", color: C.textMuted }}>Awaiting approval</span>
      </div>
      <div style={{ fontSize: "13px", color: C.textPrimary, marginBottom: "10px", fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace' }}>
        {write.summary}
      </div>
      <div style={{ display: "flex", gap: "8px" }}>
        <button
          type="button"
          disabled={submitting}
          onClick={onApprove}
          style={{
            border: "none", borderRadius: "8px", padding: "6px 16px", fontSize: "12px", fontWeight: 600,
            background: submitting ? C.border : C.accentBlue, color: "#fff", cursor: submitting ? "default" : "pointer",
            fontFamily: "inherit",
          }}
        >{submitting ? "Approving…" : "Approve"}</button>
        <button
          type="button"
          disabled={submitting}
          onClick={() => onResolved({ messageId, nonce: write.nonce })}
          style={{
            border: `1px solid ${C.border}`, borderRadius: "8px", padding: "6px 16px", fontSize: "12px", fontWeight: 500,
            background: C.bg, color: C.textMuted, cursor: submitting ? "default" : "pointer", fontFamily: "inherit",
          }}
        >Cancel</button>
      </div>
    </div>
  );
}

function StatusTag({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      padding: "2px 7px", borderRadius: "999px", fontSize: "10px", fontWeight: 600,
      background: color + "1A", color, letterSpacing: "0.02em", textTransform: "uppercase",
    }}>{label}</span>
  );
}

function actionStatus(a: ChatAction): { statusLabel: string | null; statusColor: string } {
  // Color-coded micro-tags for common tool outcomes. Reserved strictly for data
  // alerts — never used on the icon/avatar.
  if (!a.ok) return { statusLabel: "Failed", statusColor: C.dangerRed };
  if (a.name === "set_product_status" && /DRAFT/i.test(a.summary)) return { statusLabel: "Unavailable", statusColor: C.dangerRed };
  if (a.name === "set_product_status" && /ACTIVE/i.test(a.summary)) return { statusLabel: "Active", statusColor: C.okGreen };
  if (a.name === "update_inventory") return { statusLabel: "Restocked", statusColor: C.okGreen };
  if (a.name === "update_price") return { statusLabel: "Price updated", statusColor: C.accentBlue };
  return { statusLabel: null, statusColor: C.textMuted };
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

// ─── Helpers: proactive greeting, dynamic placeholder, thinking row ──────────

/** Proactive headline. Surfaces a real inventory insight instead of "Hello,
 *  Omar" — what a co-pilot does on first open. */
function greetingHeadline(summary: InventorySummary): string {
  if (summary.outOfStock > 0) {
    return `${summary.outOfStock} ${summary.outOfStock === 1 ? "product is" : "products are"} out of stock`;
  }
  if (summary.lowStock > 0) {
    return `${summary.lowStock} ${summary.lowStock === 1 ? "product is" : "products are"} running low`;
  }
  if (summary.total === 0) {
    return "Nothing to watch yet";
  }
  return `All ${summary.total} products are healthy`;
}

/** Proactive subline. Offers a concrete next action drawn from the summary. */
function greetingSubline(summary: InventorySummary): string {
  if (summary.outOfStock > 0 && summary.lowStock > 0) {
    return `${summary.outOfStock} out-of-stock and ${summary.lowStock} low-stock items need attention. Want me to draft a restock report or mark the unavailable ones as DRAFT?`;
  }
  if (summary.outOfStock > 0) {
    return `${summary.outOfStock} ${summary.outOfStock === 1 ? "item has" : "items have"} zero stock. I can mark them unavailable (DRAFT) so they stop showing in your store, or draft a restock order. Which would you like?`;
  }
  if (summary.lowStock > 0) {
    return `${summary.lowStock} ${summary.lowStock === 1 ? "item is" : "items are"} at or below 5 units. Want me to generate a restock report for them?`;
  }
  if (summary.total === 0) {
    return "Once you add products to this store I can watch stock levels, suggest restocks, and keep availability in sync. Try me by asking 'What's running low?' after you add inventory.";
  }
  return "Your stock levels look good. Ask me to summarize inventory, show low-stock items, or update a price.";
}

/** Context-aware composer placeholder. Guides the next action based on the
 *  most recent assistant turn or the loaded summary. */
function composerPlaceholder({ summary, messages, isThinking }: { summary: InventorySummary; messages: Message[]; isThinking: boolean }): string {
  if (isThinking) return "Reeve is working on it…";
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  if (lastAssistant && /low.?stock|out.?of.?stock|threshold/i.test(lastAssistant.content)) {
    return "Ask Reeve to restock the low items, or mark unavailable…";
  }
  if (lastAssistant && /price|pricing|cost/i.test(lastAssistant.content)) {
    return "Ask Reeve to update a price next…";
  }
  if (summary.outOfStock > 0) return "Ask Reeve to mark out-of-stock items unavailable…";
  if (summary.lowStock > 0) return "Ask Reeve to reorder the low-stock items…";
  if (summary.total === 0) return "Ask Reeve to summarize your inventory…";
  return "Ask Reeve about your inventory…  (Enter to send, Shift+Enter for newline)";
}

/** Thinking row: shimmer icon + a cycling label that randomly rotates through
 *  a pool of "cognitive stage" words. Replaces the static "Thinking" + dots,
 *  which made the agent look slow + was dishonest about what was happening. */
const THINKING_WORDS = [
  "Thinking", "Brainstorming", "Condensing", "Considering", "Deliberating",
  "Reflecting", "Reasoning", "Weighing", "Synthesizing", "Composing",
];
function ThinkingRow() {
  const [word, setWord] = useState(THINKING_WORDS[0]);
  useEffect(() => {
    // Pick a random word every ~1.2s while mounted. Avoid showing the same
    // word twice in a row so the change is perceptible.
    const id = setInterval(() => {
      setWord((prev) => {
        const pool = THINKING_WORDS.filter((w) => w !== prev);
        return pool[Math.floor(Math.random() * pool.length)];
      });
    }, 1200);
    return () => clearInterval(id);
  }, []);
  return (
    <div style={{ display: "flex", gap: "12px", alignItems: "center", padding: "10px 0 12px" }}>
      <ReeveThinkingIcon size={36} />
      <span
        key={word}
        style={{ fontSize: "13px", color: C.textMuted, fontWeight: 500, animation: "reeveFadeIn 0.4s ease" }}
      >{word}…</span>
    </div>
  );
}

// ─── Reeve brand icon ─────────────────────────────────────────────────────────
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
      "@keyframes reeveSweep{0%{transform:translateX(-120%)}100%{transform:translateX(280%)}}" +
      "@keyframes reeveFadeIn{0%{opacity:0;transform:translateY(2px)}100%{opacity:1;transform:translateY(0)}}",
    ),
  },
];

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
