// app/routes/app._index.tsx — Reeve AI dashboard, embedded in Shopify.
//
// Layout: inventory KPIs + activity feed as the main page, with a floating
// button (bottom-right) that opens a Sidekick-style slide-in chat panel.
//
// NOTE on custom elements: the Shopify Polaris web components (s-page, s-section,
// etc.) are used only for static DISPLAY — we never pass a controlled `value`,
// `style={{}}`, or `onChange`/`onInput` to them, because React 18 + web-component
// controlled bindings throw or silently break. All interactive bits (the chat
// panel shell, the textarea, buttons) are plain native DOM with standard React.

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

// ─── Loader: live inventory summary + recent chat + activity ─────────────────

interface InventorySummary {
  total: number;
  inStock: number;
  lowStock: number;
  outOfStock: number;
  topLow: { id: string; title: string; inventory: number }[];
}

interface ChatAction {
  name: string;
  summary: string;
  ok: boolean;
  error?: string;
}
interface Message {
  id: string;
  role: string;
  content: string;
  actions: ChatAction[] | null;
}
interface ActivityItem {
  id: string;
  type: string;
  severity: string;
  source: string;
  message: string;
  createdAt: string;
}

interface LoaderData {
  summary: InventorySummary;
  messages: Message[];
  activities: ActivityItem[];
  provider: "nvidia" | "demo";
}

export const loader = async ({ request }: LoaderFunctionArgs): Promise<LoaderData> => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  interface ProductsData {
    products: {
      edges: Array<{
        node: {
          id: string;
          title: string;
          variants: { edges: Array<{ node: { inventoryQuantity: number | null } }> };
        };
      }>;
    };
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

  let total = 0,
    inStock = 0,
    lowStock = 0,
    outOfStock = 0;
  const lowList: { id: string; title: string; inventory: number }[] = [];
  for (const e of json.data.products.edges) {
    const minInv = Math.min(...e.node.variants.edges.map((v) => v.node.inventoryQuantity ?? 0));
    total++;
    if (minInv <= 0) outOfStock++;
    else if (minInv <= 5) {
      lowStock++;
      lowList.push({ id: e.node.id, title: e.node.title, inventory: minInv });
    } else inStock++;
  }
  lowList.sort((a, b) => a.inventory - b.inventory);

  const dbMessages = await prisma.chatMessage.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const activities = await getActivities(shop, 6);

  return {
    summary: { total, inStock, lowStock, outOfStock, topLow: lowList.slice(0, 5) },
    messages: dbMessages.reverse().map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      actions: m.actionsJson ? (JSON.parse(m.actionsJson) as ChatAction[]) : null,
    })),
    activities: activities.map((a) => ({
      id: a.id,
      type: a.type,
      severity: a.severity,
      source: a.source,
      message: a.message,
      createdAt: a.createdAt.toISOString(),
    })),
    provider: process.env.NVIDIA_API_KEY ? "nvidia" : "demo",
  };
};

// ─── Dashboard component ──────────────────────────────────────────────────────

export default function ReeveDashboard() {
  const { summary, messages: initialMessages, provider } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof loader>();
  const chatFetcher = useFetcher<{ response?: string; actions?: ChatAction[]; provider?: string; error?: string }>();
  const shopify = useAppBridge();

  const [panelOpen, setPanelOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastReplyRef = useRef<string | null>(null); // guard against double-append

  // When the loader re-runs (after a chat invalidates), refresh messages.
  useEffect(() => {
    if (fetcher.data?.messages) {
      setMessages(fetcher.data.messages);
    }
  }, [fetcher.data]);

  // Auto-scroll the chat to the bottom on new messages / thinking state.
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
    chatFetcher.submit(
      { message: trimmed },
      { method: "POST", action: "/app/chat", encType: "application/json" },
    );
  };

  // When the chat fetcher returns, append the agent reply + reload loader.
  useEffect(() => {
    if (chatFetcher.data?.response && chatFetcher.state === "idle") {
      // Guard: only append once per response.
      const sig = `${chatFetcher.data.response}`;
      if (lastReplyRef.current !== sig) {
        lastReplyRef.current = sig;
        setMessages((m) => [
          ...m,
          {
            id: `a-${Date.now()}`,
            role: "assistant",
            content: chatFetcher.data.response!,
            actions: chatFetcher.data.actions ?? null,
          },
        ]);
        shopify.toast.show("Reeve replied");
        fetcher.load("/app"); // refresh inventory + activity
      }
    }
    if (chatFetcher.data?.error && chatFetcher.state === "idle") {
      shopify.toast.show(chatFetcher.data.error, { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatFetcher.data, chatFetcher.state]);

  return (
    <>
      {/* ─── Main dashboard page ─── */}
      <s-page heading="Reeve AI">
        <div slot="primary-action">
          <s-badge tone={provider === "nvidia" ? "success" : "attention"}>
            {provider === "nvidia" ? "Live AI" : "Demo mode"}
          </s-badge>
        </div>

        {/* KPI tiles */}
        <s-section heading="Inventory at a glance">
          <s-stack direction="inline" gap="loose" wrap>
            <Stat label="Total products" value={summary.total} />
            <Stat label="In stock" value={summary.inStock} />
            <Stat label="Low stock" value={summary.lowStock} tone="caution" />
            <Stat label="Out of stock" value={summary.outOfStock} tone="critical" />
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

        {/* Hint card pointing to the chat */}
        <s-section heading="Your AI intern">
          <s-paragraph>
            Click the <strong>Reeve</strong> button (bottom-right) to chat. Ask
            "what's running low?" or "summarize my inventory" and watch it act on
            your store.
          </s-paragraph>
        </s-section>
      </s-page>

      {/* ─── Floating button (always visible) ─── */}
      <FloatingChatButton open={panelOpen} onToggle={() => setPanelOpen((o) => !o)} hasNew={messages.some((m) => m.role === "assistant")} />

      {/* ─── Slide-in chat panel (Sidekick-style) ─── */}
      <ChatPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        messages={messages}
        input={input}
        onInputChange={setInput}
        onSend={send}
        isThinking={isThinking}
        provider={provider}
        scrollRef={scrollRef}
      />
    </>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
      <s-stack direction="block" gap="none">
        <s-text alignment="center" appearance="code" {...(tone ? { tone } : {})}>
          {value}
        </s-text>
        <s-text alignment="center" tone="subdued">
          {label}
        </s-text>
      </s-stack>
    </s-box>
  );
}

function FloatingChatButton({ open, onToggle }: { open: boolean; onToggle: () => void; hasNew: boolean }) {
  return (
    <button
      onClick={onToggle}
      style={{
        position: "fixed",
        bottom: "24px",
        right: "24px",
        zIndex: 1000,
        width: "56px",
        height: "56px",
        borderRadius: "50%",
        background: "#000",
        color: "#FFD60A",
        border: "none",
        cursor: "pointer",
        boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "22px",
        fontWeight: 700,
        transition: "transform 0.15s ease",
      }}
      aria-label={open ? "Close Reeve chat" : "Open Reeve chat"}
      title="Chat with Reeve"
    >
      {open ? "✕" : "R"}
    </button>
  );
}

interface ChatPanelProps {
  open: boolean;
  onClose: () => void;
  messages: Message[];
  input: string;
  onInputChange: (v: string) => void;
  onSend: (text: string) => void;
  isThinking: boolean;
  provider: "nvidia" | "demo";
  scrollRef: React.RefObject<HTMLDivElement | null>;
}

function ChatPanel({ open, onClose, messages, input, onInputChange, onSend, isThinking, provider, scrollRef }: ChatPanelProps) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend(input);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        right: open ? 0 : "-420px",
        bottom: 0,
        width: "400px",
        maxWidth: "100vw",
        background: "#fff",
        borderLeft: "1px solid #e1e1e1",
        boxShadow: "-4px 0 24px rgba(0,0,0,0.08)",
        zIndex: 1001,
        display: "flex",
        flexDirection: "column",
        transition: "right 0.25s ease",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          padding: "14px 16px",
          borderBottom: "1px solid #e1e1e1",
          background: "#000",
          color: "#fff",
        }}
      >
        <div
          style={{
            width: "32px",
            height: "32px",
            borderRadius: "50%",
            background: "#FFD60A",
            color: "#000",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 700,
            fontSize: "15px",
          }}
        >
          R
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: "14px", fontWeight: 600 }}>Reeve Agent</div>
          <div style={{ fontSize: "11px", opacity: 0.7 }}>
            {provider === "nvidia" ? "Live AI" : "Demo mode"} · Inventory operations
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            background: "transparent",
            border: "none",
            color: "#fff",
            fontSize: "20px",
            cursor: "pointer",
            lineHeight: 1,
          }}
        >
          ✕
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "16px" }}>
        {messages.length === 0 && (
          <div style={{ textAlign: "center", color: "#999", fontSize: "13px", marginTop: "40px" }}>
            Hi — I'm Reeve. Ask me what's running low, or have me fix your stock levels.
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} msg={m} />
        ))}
        {isThinking && (
          <div style={{ display: "flex", gap: "8px", alignItems: "center", color: "#999", fontSize: "13px", padding: "8px 0" }}>
            <span className="dot" style={dotStyle(0)} />
            <span className="dot" style={dotStyle(1)} />
            <span className="dot" style={dotStyle(2)} />
            <span>Reeve is thinking…</span>
          </div>
        )}
      </div>

      {/* Suggestion chips */}
      <div style={{ padding: "8px 16px 0", display: "flex", flexWrap: "wrap", gap: "6px" }}>
        {["What's running low?", "Summarize my inventory", "Show my products"].map((s) => (
          <button
            key={s}
            onClick={() => onSend(s)}
            disabled={isThinking}
            style={{
              border: "1px solid #e1e1e1",
              background: "#f6f6f7",
              borderRadius: "999px",
              padding: "4px 10px",
              fontSize: "11px",
              color: "#666",
              cursor: "pointer",
            }}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Composer */}
      <div style={{ padding: "12px 16px", borderTop: "1px solid #e1e1e1", display: "flex", gap: "8px", alignItems: "flex-end" }}>
        <textarea
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Message Reeve…"
          rows={2}
          style={{
            flex: 1,
            resize: "none",
            border: "1px solid #e1e1e1",
            borderRadius: "8px",
            padding: "8px 10px",
            fontSize: "14px",
            fontFamily: "inherit",
            outline: "none",
            minHeight: "40px",
          }}
        />
        <button
          onClick={() => onSend(input)}
          disabled={!input.trim() || isThinking}
          style={{
            background: input.trim() && !isThinking ? "#000" : "#ccc",
            color: "#FFD60A",
            border: "none",
            borderRadius: "8px",
            padding: "0 14px",
            height: "40px",
            cursor: input.trim() && !isThinking ? "pointer" : "default",
            fontWeight: 600,
            fontSize: "14px",
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}

function MessageBubble({ msg }: { msg: Message }) {
  const isUser = msg.role === "user";
  return (
    <div style={{ marginBottom: "14px" }}>
      <div
        style={{
          display: "inline-block",
          maxWidth: "85%",
          padding: "10px 12px",
          borderRadius: isUser ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
          background: isUser ? "#000" : "#f6f6f7",
          color: isUser ? "#fff" : "#000",
          fontSize: "13px",
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          float: isUser ? "right" : "left",
          clear: "both",
        }}
      >
        {msg.content}
      </div>
      {msg.actions && msg.actions.length > 0 && (
        <div style={{ clear: "both", marginTop: "6px", display: "flex", flexDirection: "column", gap: "4px" }}>
          {msg.actions.map((a, i) => (
            <div
              key={i}
              style={{
                border: "1px solid #e1e1e1",
                borderRadius: "6px",
                padding: "6px 8px",
                fontSize: "11px",
                background: a.ok ? "#fafafa" : "#fff0f0",
                borderColor: a.ok ? "#e1e1e1" : "#ffcaca",
              }}
            >
              <strong style={{ color: a.ok ? "#008060" : "#d72c0d" }}>{a.ok ? "✓" : "✗"}</strong>{" "}
              {a.summary}
              {a.error ? ` — ${a.error}` : ""}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function dotStyle(delay: number): React.CSSProperties {
  return {
    display: "inline-block",
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    background: "#999",
    animation: "reeveBounce 1s infinite",
    animationDelay: `${delay * 0.15}s`,
  };
}

// Keyframes for the thinking dots. Injected once.
// (React doesn't support @keyframes inline, so we use a <style> tag.)
export const links = () => [
  {
    rel: "stylesheet",
    href: "data:text/css," + encodeURIComponent("@keyframes reeveBounce{0%,80%,100%{transform:scale(0.6);opacity:0.5}40%{transform:scale(1);opacity:1}}"),
  },
];

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
