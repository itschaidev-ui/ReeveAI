# Reeve Shop — AI Inventory Agent embedded in Shopify

> © 2026 Prismlink LLC. All rights reserved.

Reeve AI is an inventory operations agent that lives **inside the Shopify admin**.
Message it in plain English — *"what's running low?"*, *"mark the chain out of
stock"*, *"summarize my inventory"* — and it reads your store and acts through
the Shopify Admin GraphQL API. Every action is audited.

This is the **embedded Shopify app** built on Shopify's React Router template.

## What it does

- **Embedded in Shopify** — opens as an app inside the merchant's Shopify admin
- **Live AI agent** — powered by an open LLM (Llama 3.1 70B / GLM / Qwen via NVIDIA's free endpoint)
- **Real inventory actions** — reads products, detects low/out-of-stock, updates inventory, status, and price through the authenticated Admin GraphQL client
- **Audit trail** — every agent action is logged with before/after detail
- **No pasted tokens** — Shopify's OAuth install flow handles all auth

## Tech stack

| Layer | Choice |
|---|---|
| Framework | React Router 7 (Shopify template) |
| UI | Shopify Polaris web components (`<s-...>`) |
| AI | NVIDIA build.nvidia.com (OpenAI-compatible endpoint) via `openai` SDK |
| Shopify | `@shopify/shopify-app-react-router` — OAuth, sessions, App Bridge, authenticated GraphQL |
| Database | Prisma + SQLite (Session, ChatMessage, Activity) |

## Getting started

```bash
npm install
shopify app dev
```

The CLI provisions a Cloudflare tunnel, logs you into your Partner account, and
installs the app into your dev store. Press `p` to open it in your Shopify admin.

### Enable live AI (recommended)

Without an NVIDIA key, the agent runs in deterministic **demo mode** (canned
responses that still exercise the tools). For real conversational AI:

1. Go to [build.nvidia.com](https://build.nvidia.com) → sign in → **Get API Key**
2. Pick a model (e.g. `meta/llama-3.1-70b-instruct`) and note its exact ID
3. Add to `.env`:
   ```
   NVIDIA_API_KEY=nvapi-...
   NVIDIA_MODEL=meta/llama-3.1-70b-instruct
   ```
4. Restart `shopify app dev`. The badge flips from "Demo mode" → "Live AI".

## Scopes

The app requests: `read_products`, `write_products`, `read_inventory`,
`write_inventory` — enough to read inventory and act on it. No customer/order
access.

## Architecture

```
Merchant message ─► app/routes/app.chat.tsx
                       │
                       ▼
                  app/lib/agent.server.ts   (the loop)
                       │
            ┌──────────┴──────────┐
            ▼                     ▼
   app/lib/llm.server.ts   app/lib/agent-tools.server.ts
   (NVIDIA LLM plans)      (Shopify GraphQL actions)
                                   │
                                   ▼
                          app/lib/audit.server.ts
                          (Activity audit log)
```

The agent: loads recent chat history → asks the LLM to plan a response + tool
calls → executes each tool through the authenticated Shopify admin GraphQL
client → composes a reply → persists the conversation + logs an audit entry.
