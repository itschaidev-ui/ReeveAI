// ────────────────────────────────────────────────────────────────────────────
// app/lib/agent-tools.server.ts — the agent's tool catalog.
//
// Each tool is a Shopify Admin GraphQL query/mutation executed through the
// authenticated `admin` client (no tokens, no REST — Shopify's session handles
// auth). The agent picks tools, dispatch() runs them, and results become the
// action cards the merchant sees.
// ────────────────────────────────────────────────────────────────────────────

import { z } from "zod";
import { logActivity } from "./audit.server";

// Shopify's admin graphql client shape (from @shopify/shopify-app-react-router).
interface AdminClient {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
}

export interface ToolResult {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  summary: string;
  ok: boolean;
  error?: string;
}

export interface ToolCtx {
  admin: AdminClient;
  shop: string;
}

// ─── Tool catalog (shown to the LLM in the prompt) ────────────────────────────

export const toolCatalog = [
  {
    name: "get_products",
    description: "List products in the store with their inventory counts, status, and variant ids. READ-only — runs immediately. The `query` arg supports Shopify's search syntax — use it to filter BEFORE acting instead of asking the merchant to name products. Examples: query:'status:archived' (all archived), query:'status:draft', query:'status:active', query:'snowboard' (title match). Always prefer a targeted query over a broad one.",
    args: { query: "string?", limit: "number?" },
  },
  {
    name: "get_low_stock_products",
    description: "Return products whose inventory is at or below the given threshold (default 5). Each row includes title, status, minInventory, id (product gid), and variants[].id (variant gid). READ-only.",
    args: { threshold: "number?" },
  },
  {
    name: "get_locations",
    description: "Return the inventory locations configured on the shop (the place stock is tracked at). Each row includes id (location gid), name, and active flag. You need a locationId to call update_inventory. READ-only — runs immediately.",
    args: {},
  },
  {
    name: "update_inventory",
    description: "Set a product variant's absolute inventory level at a location. WRITE — Reeve will PROPOSE this action; the merchant must approve it before it runs. Needs a variantId (from get_low_stock_products/get_products results) and a locationId (from get_locations).",
    args: { variantId: "string", locationId: "string", available: "number" },
    disposition: "propose",
  },
  {
    name: "set_product_status",
    description: "Set a product's status. WRITE — Reeve will PROPOSE this; the merchant must approve before it runs. Needs a productId (from get_low_stock_products/get_products results). Status values: ACTIVE (ready to sell, listed on channels), DRAFT (not ready, unavailable), ARCHIVED (no longer sold, hidden from channels), UNLISTED (active but only viewable via direct link).",
    args: { productId: "string", status: "ACTIVE|DRAFT|ARCHIVED|UNLISTED" },
    disposition: "propose",
  },
  {
    name: "update_price",
    description: "Set a product variant's price in dollars (e.g. 49.99). WRITE — Reeve will PROPOSE this; the merchant must approve before it runs. Needs a variantId.",
    args: { variantId: "string", price: "string" },
    disposition: "propose",
  },
  {
    name: "summarize_inventory",
    description: "Return a synthesized health summary: total products, low-stock count, out-of-stock count. READ-only.",
    args: {},
  },
  // ─── Chart tools (read-only aggregations that return a Recharts-ready shape) ───
  // These produce a chart card in the chat thread. Pick by MERCHANT INTENT:
  //   "show sales/revenue over time"          → chart_sales_over_time(days=30)
  //   "top products / best sellers / units"   → chart_top_products_by_units(days=30, limit=10)
  //   "revenue/units by type/vendor"          → chart_revenue_by_dimension(dimension="product_type", days=30)
  //   "inventory health / catalog breakdown"  → chart_inventory_distribution(dimension="status"|"product_type"|"vendor"|"stock_health")
  //   "new customers over time"               → chart_new_customers_over_time(days=90)
  //   "top/most-used discounts/codes"         → chart_top_discounts_by_usage(limit=8)
  {
    name: "chart_sales_over_time",
    description: "Return a daily/weekly line chart of NET sales over the last N days (default 30, max 365). Net = gross order total minus refunds, in shop currency. Use when the merchant asks for a sales trend, revenue over time, or 'how are sales going'. READ-only — runs immediately and renders as a line chart card. Note: capped at the most recent ~1000 orders in the window; for shops with very high order volume it shows a 'last 1000 orders' caveat.",
    args: { days: "number?" },
  },
  {
    name: "chart_top_products_by_units",
    description: "Return a horizontal bar chart ranking the top products by UNITS SOLD over the last N days (default 30). Use when the merchant asks 'what are my best sellers', 'top products', 'most-sold items'. READ-only. Args: days (default 30, max 365), limit (default 10, max 25).",
    args: { days: "number?", limit: "number?" },
  },
  {
    name: "chart_revenue_by_dimension",
    description: "Bucket order REVENUE (gross line-item totals) into a donut (≤7 slices) or bar chart by a categorical dimension over the last N days. Use for 'revenue by product_type', 'sales by vendor', 'orders by status'. READ-only. Args: dimension = 'product_type' | 'vendor' | 'status' | 'fulfillment_status' (required), days (default 30, max 365).",
    args: { dimension: "string", days: "number?" },
  },
  {
    name: "chart_inventory_distribution",
    description: "Snapshot the CURRENT catalog as a donut (≤7 slices) by: 'status' (ACTIVE/DRAFT/ARCHIVED/UNLISTED), 'product_type', 'vendor', or 'stock_health' (in-stock ≤ threshold, low ≤5, out ≤0 — same threshold already used elsewhere). No date window — this is a live catalog count. READ-only. Args: dimension (required).",
    args: { dimension: "string" },
  },
  {
    name: "chart_new_customers_over_time",
    description: "Line chart of new customers per day/week over the last N days (default 90). Use when the merchant asks 'how many new customers', 'customer growth', 'signups over time'. READ-only. Capped at the most recent ~1000 customers; over about 60 days it collapses to a weekly bucket for readability.",
    args: { days: "number?" },
  },
  {
    name: "chart_top_discounts_by_usage",
    description: "Horizontal bar chart of the most-used discount codes (price rules) by USAGE count and total sales. Use when the merchant asks 'which discounts work best', 'most-used codes', 'coupon performance'. READ-only. Args: limit (default 8, max 25).",
    args: { limit: "number?" },
  },
];

/** Tools that mutate Shopify state. These are gated behind an Approve card —
 *  the agent never executes them directly. */
export const WRITE_TOOLS: Record<string, true> = {
  update_inventory: true,
  set_product_status: true,
  update_price: true,
};

export function isWriteTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(WRITE_TOOLS, name);
}

// ─── Zod schemas for arg validation ────────────────────────────────────────────

const schemas = {
  get_products: z.object({ query: z.string().optional(), limit: z.number().int().min(1).max(250).optional() }),
  get_low_stock_products: z.object({ threshold: z.number().int().min(0).optional() }),
  get_locations: z.object({}).strict(),
  update_inventory: z.object({ variantId: z.string(), locationId: z.string(), available: z.number().int().min(0) }),
  set_product_status: z.object({ productId: z.string(), status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED", "UNLISTED"]) }),
  update_price: z.object({ variantId: z.string(), price: z.string() }),
  summarize_inventory: z.object({}).strict(),
  chart_sales_over_time: z.object({ days: z.number().int().min(1).max(365).optional() }),
  chart_top_products_by_units: z.object({ days: z.number().int().min(1).max(365).optional(), limit: z.number().int().min(1).max(25).optional() }),
  chart_revenue_by_dimension: z.object({
    dimension: z.enum(["product_type", "vendor", "status", "fulfillment_status"]),
    days: z.number().int().min(1).max(365).optional(),
  }),
  chart_inventory_distribution: z.object({
    dimension: z.enum(["status", "product_type", "vendor", "stock_health"]),
  }),
  chart_new_customers_over_time: z.object({ days: z.number().int().min(1).max(365).optional() }),
  chart_top_discounts_by_usage: z.object({ limit: z.number().int().min(1).max(25).optional() }),
} as const;

export type ToolName = keyof typeof schemas;

// ─── GraphQL helpers ────────────────────────────────────────────────────────────

async function gql<T>(admin: AdminClient, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await admin.graphql(query, variables ? { variables } : undefined);
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data as T;
}

// ─── ShopifyQL helper (read_reports scope gated) ────────────────────────────
// ShopifyQL runs a server-side SQL-like aggregation that bypasses the 250/page
// connection cap. We call shopifyqlQuery(query) → tableData { columns, rows }.
// Columns is an array of header strings; rows is a parallel array of arrays
// where each entry corresponds positionally to columns[]. Row values come back
// as strings — including numeric/money values — so callers parse as needed.
//
// Returns null on ANY failure (parse error, scope denial, schema mismatch).
// The two chart_* callers that use it FALL BACK to raw pagination when this
// returns null, so merchants whose shop lacks read_reports (or whose API
// version surfaces a different schema) still get a chart — just from the
// paginated path instead of server-aggregated one.

interface ShopifyQLTableData {
  shopifyqlQuery?: {
    parseErrors?: Array<{ message: string }>;
    tableData?: { columns?: string[]; rows?: string[][] };
  };
}

async function runShopifyQL(
  admin: AdminClient,
  query: string,
): Promise<{ columns: string[]; rows: string[][] } | null> {
  try {
    const data = await gql<ShopifyQLTableData>(admin, `#graphql
      query ShopifyQL($query: String!) {
        shopifyqlQuery(query: $query) {
          parseErrors { message }
          tableData { columns rows }
        }
      }`, { query });
    const q = data.shopifyqlQuery;
    if (!q) return null;
    if (q.parseErrors && q.parseErrors.length) return null;
    if (!q.tableData?.columns || !q.tableData?.rows) return null;
    return { columns: q.tableData.columns, rows: q.tableData.rows };
  } catch {
    // gql() throws on json.errors. Anything from "Requires read_reports scope"
    // to "schema not found" lands here. Treat as fallback-blackhole.
    return null;
  }
}

/** Parse a string cell to a float (0 on missing/NaN); ShopifyQL returns money
 *  and counts as string-positional columns, so we coerce defensively. */
function toNumber(cell: string | undefined | null): number {
  if (cell == null) return 0;
  const n = parseFloat(cell.replace(/[^0-9.\-]/g, ""));
  return isFinite(n) ? n : 0;
}

// ─── Pagination helpers (used by the chart_* / aggregate read tools) ─────────────
// Shopify GraphQL connections are cursor-based (first/after, no offset) with a
// hard cap of 250 rows per page and 1000 cost points per query. We cap at 4
// pages (1000 rows) so aggregations stay well within the cost ceiling; the
// chart caption surfaces a "showing last ~1000 rows" note when the cap kicks.

const MAX_PAGES = 4;
const PAGE_SIZE = 250;

/** Detect access-denied / scope errors from GraphQL result text so we can return
 *  a friendlier ToolResult.ok=false rather than a raw stack trace. The cli's
 *  gql() helper throws on `json.errors`, so this trap lives in the dispatch
 *  wrapper around the order/customer/discount queries specifically. */
function scopeError(extra: string): string {
  return `Scope error — Reeve needs ${extra}. Re-authorize the app (Shopify admin will prompt for the new scopes on next open).`;
}

/** Pull a human-readable "showing last N rows" caveat for a chart caption when
 *  we hit our pagination cap. Returns the empty string when we have everything. */
function caveatIfCapped(rowsFetched: number, hitCap: boolean, thing: string): string {
  return hitCap ? ` (showing last ~${rowsFetched} ${thing} in window)` : "";
}

/** ISO date bucket key — daily for windows under ~60d, weekly otherwise so the
 *  chart stays readable at scale. Returns "YYYY-MM-DD" (week starts Monday). */
function bucketKey(iso: string, days: number): string {
  const d = new Date(iso);
  if (days <= 60) {
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
  }
  // weekly bucket — round date down to Monday
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day + 6) % 7; // days since Monday
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - diff);
  return monday.toISOString().slice(0, 10);
}

/** Sum money-set fields safely (parsing strings, ignoring null/undefined). */
function sumMoney(amounts: Array<string | number | null | undefined>): number {
  let total = 0;
  for (const a of amounts) {
    if (a == null) continue;
    total += typeof a === "number" ? a : parseFloat(a);
    if (!isFinite(total)) { total = 0; break; }
  }
  return total;
}

/** Currency formatting for chart captions. "$1,234.50" style. */
function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

export async function dispatch(
  name: ToolName,
  rawArgs: unknown,
  ctx: ToolCtx,
): Promise<ToolResult> {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      // ── get_products ──────────────────────────────────────────────────────────
      case "get_products": {
        const a = schemas.get_products.parse(args);
        interface ProductsData {
          products: { edges: Array<{ node: { id: string; title: string; status: string; vendor: string; variants: { edges: Array<{ node: { id: string; price: string; inventoryQuantity: number | null } }> } } }> };
        }
        const data = await gql<ProductsData>(ctx.admin, `#graphql
          query Products($first: Int!, $query: String) {
            products(first: $first, query: $query, sortKey: INVENTORY_TOTAL) {
              edges { node { id title status vendor variants(first: 5) { edges { node { id price inventoryQuantity } } } } }
            }
          }`, { first: a.limit ?? 50, query: a.query ?? null });
        const products = data.products.edges.map((e) => ({
          id: e.node.id, title: e.node.title, status: e.node.status, vendor: e.node.vendor,
          variants: e.node.variants.edges.map((v) => ({ id: v.node.id, price: v.node.price, inventory: v.node.inventoryQuantity })),
        }));
        // Richer summary: list the matched product names + their statuses so
        // the merchant can sanity-check what the search actually returned,
        // instead of an opaque "Found 18 product(s)".
        const summary = summarizeProductList(products, a.query);
        return ok(name, args, products, summary);
      }

      // ── get_low_stock_products ────────────────────────────────────────────────
      case "get_low_stock_products": {
        const a = schemas.get_low_stock_products.parse(args);
        const threshold = a.threshold ?? 5;
        interface ProductsData {
          products: { edges: Array<{ node: { id: string; title: string; status: string; variants: { edges: Array<{ node: { id: string; inventoryQuantity: number | null; inventoryItem?: { id: string } } }> } } }> };
        }
        const data = await gql<ProductsData>(ctx.admin, `#graphql
          query LowStockProducts($first: Int!) {
            products(first: $first, sortKey: INVENTORY_TOTAL) {
              edges { node { id title status variants(first: 10) { edges { node { id inventoryQuantity } } } } }
            }
          }`, { first: 100 });
        const low = data.products.edges
          .map((e) => ({
            id: e.node.id, title: e.node.title, status: e.node.status,
            minInventory: Math.min(...e.node.variants.edges.map((v) => v.node.inventoryQuantity ?? 0)),
            variants: e.node.variants.edges.map((v) => ({ id: v.node.id, inventory: v.node.inventoryQuantity })),
          }))
          .filter((p) => p.minInventory <= threshold);
        const summary = summarizeProductList(low, `low stock (≤${threshold})`);
        return ok(name, args, low, summary);
      }

      // ── get_locations (read) ──────────────────────────────────────────────────
      case "get_locations": {
        z.object({}).strict().parse(args);
        interface LocationsData { locations: { edges: Array<{ node: { id: string; name: string; active: boolean } }> } }
        const data = await gql<LocationsData>(ctx.admin, `#graphql
          query Locations($first: Int!) {
            locations(first: $first) { edges { node { id name active } } }
          }`, { first: 25 });
        const locations = data.locations.edges.map((e) => ({
          id: e.node.id, name: e.node.name, active: e.node.active,
        }));
        return ok(name, args, locations, `Found ${locations.length} location${locations.length === 1 ? "" : "s"}`);
      }

      // ── update_inventory (write — gated) ──────────────────────────────────────
      case "update_inventory": {
        const a = schemas.update_inventory.parse(args);
        // Need the inventory item id for the variant — fetch it first.
        const varRes = await gql<{ productVariant: { inventoryItem?: { id: string } } }>(ctx.admin, `#graphql
          query VariantItem($id: ID!) { productVariant(id: $id) { inventoryItem { id } } }`, { id: a.variantId });
        const itemId = varRes.productVariant?.inventoryItem?.id;
        if (!itemId) throw new Error("Variant does not track inventory");
        // API 2026-10: inventorySetOnHandQuantities takes
        // InventorySetOnHandQuantitiesInput! (NOT InventorySetQuantitiesInput!,
        // which doesn't exist and triggers a type-mismatch error).
        interface InvData { inventorySetOnHandQuantities: { inventoryLevel: { available: number }; userErrors: { field: string; message: string }[] } }
        const data = await gql<InvData>(ctx.admin, `#graphql
          mutation SetInventory($input: InventorySetOnHandQuantitiesInput!) {
            inventorySetOnHandQuantities(input: $input) {
              inventoryLevel { available }
              userErrors { field message }
            }
          }`, { input: { reason: "correction", setQuantities: [{ inventoryItemId: itemId, locationId: a.locationId, quantity: a.available }] } });
        const result = data.inventorySetOnHandQuantities;
        if (result.userErrors?.length) throw new Error(result.userErrors.map((e) => e.message).join(", "));
        await logActivity({ shop: ctx.shop, type: "inventory_update", severity: "success", message: `Set inventory to ${a.available} for variant ${a.variantId}`, after: { available: result.inventoryLevel.available } });
        return ok(name, args, { available: result.inventoryLevel.available }, `Set inventory to ${a.available}`);
      }

      // ── set_product_status ────────────────────────────────────────────────────
      case "set_product_status": {
        const a = schemas.set_product_status.parse(args);
        interface StatusData { productUpdate: { product: { id: string; status: string }; userErrors: { message: string }[] } }
        // API 2026-10: use the modern `product:` argument with ProductUpdateInput!.
        // The old `input:` argument expects the deprecated ProductInput type, so
        // declaring $input: ProductUpdateInput! + passing input: $input throws
        // "Type mismatch on variable $input and argument input (ProductUpdateInput! / ProductInput)".
        const data = await gql<StatusData>(ctx.admin, `#graphql
          mutation UpdateStatus($product: ProductUpdateInput!) {
            productUpdate(product: $product) { product { id status } userErrors { message } }
          }`, { product: { id: a.productId, status: a.status } });
        if (data.productUpdate.userErrors?.length) throw new Error(data.productUpdate.userErrors.map((e) => e.message).join(", "));
        await logActivity({ shop: ctx.shop, type: "availability_update", severity: "success", message: `Set product ${a.productId} status to ${a.status}`, after: { status: a.status } });
        return ok(name, args, { status: a.status }, `Set product status to ${a.status}`);
      }

      // ── update_price ──────────────────────────────────────────────────────────
      case "update_price": {
        const a = schemas.update_price.parse(args);
        // API 2026-10: productVariantUpdate is DEPRECATED (since 2024-10). The
        // modern mutation is productVariantsBulkUpdate, which needs the parent
        // productId plus a variants[] array. Fetch the productId first.
        const varRes = await gql<{ productVariant: { product?: { id: string } } }>(ctx.admin, `#graphql
          query VariantParent($id: ID!) { productVariant(id: $id) { product { id } } }`, { id: a.variantId });
        const parentId = varRes.productVariant?.product?.id;
        if (!parentId) throw new Error("Could not resolve parent product for variant");
        interface BulkData { productVariantsBulkUpdate: { productVariants: { id: string; price: string }[]; userErrors: { field: string[]; message: string }[] } }
        const data = await gql<BulkData>(ctx.admin, `#graphql
          mutation UpdatePrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
              productVariants { id price }
              userErrors { field message }
            }
          }`, { productId: parentId, variants: [{ id: a.variantId, price: a.price }] });
        const result = data.productVariantsBulkUpdate;
        if (result.userErrors?.length) throw new Error(result.userErrors.map((e) => e.message).join(", "));
        await logActivity({ shop: ctx.shop, type: "price_update", severity: "info", message: `Set price to $${a.price} for variant ${a.variantId}`, after: { price: a.price } });
        return ok(name, args, { price: a.price }, `Set price to $${a.price}`);
      }

      // ── summarize_inventory ───────────────────────────────────────────────────
      case "summarize_inventory": {
        interface SummaryData { products: { edges: Array<{ node: { variants: { edges: Array<{ node: { inventoryQuantity: number | null } }> } } }> } }
        const data = await gql<SummaryData>(ctx.admin, `#graphql
          query InventorySummary($first: Int!) {
            products(first: $first) { edges { node { variants(first: 10) { edges { node { inventoryQuantity } } } } } }
          }`, { first: 250 });
        const products = data.products.edges;
        let total = 0, low = 0, out = 0;
        for (const e of products) {
          const minInv = Math.min(...e.node.variants.edges.map((v) => v.node.inventoryQuantity ?? 0));
          total++;
          if (minInv <= 0) out++;
          else if (minInv <= 5) low++;
        }
        return ok(name, args, { total, low_stock: low, out_of_stock: out, in_stock: total - low - out }, `Summarized ${total} products (${low} low, ${out} out)`);
      }

      // ── chart_sales_over_time ────────────────────────────────────────────────
      case "chart_sales_over_time": {
        const a = schemas.chart_sales_over_time.parse(args);
        const days = a.days ?? 30;

        // ── ShopifyQL path (preferred) ──────────────────────────────────────────
        // FROM sales SHOW total_sales, gross_sales, returns TIMESERIES day SINCE -Nd
        // Server-side aggregation — bypasses the 250/page connection ceiling.
        // Falls back to raw pagination below on any failure.
        const qlSales = await runShopifyQL(ctx.admin, `FROM sales SHOW total_sales, gross_sales, returns TIMESERIES day SINCE -${days}d`);
        if (qlSales?.rows?.length && qlSales.columns?.length >= 2) {
          const findCol = (name: string) => qlSales.columns.findIndex((c: string) => c.toLowerCase().includes(name.toLowerCase()));
          const iDate = qlSales.columns.findIndex((c) => /date|day|month|time/i.test(c));
          const iNet = findCol("total_sales");
          const iGross = findCol("gross_sales");
          const iRefunds = findCol("returns");
          if (iDate >= 0 && (iNet >= 0 || iGross >= 0)) {
            const points = qlSales.rows.map((r) => {
              const date = (r[iDate] ?? "").slice(0, 10);
              const gross = iGross >= 0 ? toNumber(r[iGross]) : 0;
              const refunds = iRefunds >= 0 ? toNumber(r[iRefunds]) : 0;
              const net = iNet >= 0 ? toNumber(r[iNet]) : gross - refunds;
              return { date, net: Math.round(net * 100) / 100, gross: Math.round(gross * 100) / 100, refunds: Math.round(refunds * 100) / 100 };
            }).sort((x, y) => x.date.localeCompare(y.date));
            const totalNet = points.reduce((s, p) => s + p.net, 0);
            const summary = `Daily net sales — last ${days} days · ${points.length} days · ${money(totalNet)}`;
            return ok(name, args, { points, ordersCount: points.length, capped: false, viaSageQL: true }, summary);
          }
        }

        // ── Fallback: raw order pagination ───────────────────────────────────────
        const filter = `processed_at:>=-${days}d`;
        interface OrderRow { processedAt: string; totalPriceSet: { shopMoney: { amount: string } }; totalRefundedSet: { shopMoney: { amount: string } } }
        interface OrdersConn { orders: { edges: Array<{ node: OrderRow }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
        const rows: OrderRow[] = [];
        let cursor: string | null = null;
        let page = 0;
        let hitCap = false;
        while (page < MAX_PAGES) {
          const data = await gql<OrdersConn>(ctx.admin, `#graphql
            query SalesPages($first: Int!, $query: String!, $after: String) {
              orders(first: $first, query: $query, sortKey: PROCESSED_AT, after: $after) {
                edges { node { processedAt totalPriceSet { shopMoney { amount } } totalRefundedSet { shopMoney { amount } } } }
                pageInfo { hasNextPage endCursor }
              }
            }`, { first: PAGE_SIZE, query: filter, after: cursor });
          for (const e of data.orders.edges) rows.push(e.node);
          if (!data.orders.pageInfo.hasNextPage || !data.orders.pageInfo.endCursor) break;
          cursor = data.orders.pageInfo.endCursor;
          page++;
          if (page >= MAX_PAGES) hitCap = true;
        }
        // Aggregate into day/week buckets.
        const bucket = new Map<string, { net: number; gross: number; refunds: number }>();
        for (const r of rows) {
          const k = bucketKey(r.processedAt, days);
          const gross = sumMoney([r.totalPriceSet?.shopMoney?.amount]);
          const refunds = sumMoney([r.totalRefundedSet?.shopMoney?.amount]);
          const cur = bucket.get(k) ?? { net: 0, gross: 0, refunds: 0 };
          cur.gross += gross; cur.refunds += refunds; cur.net += gross - refunds;
          bucket.set(k, cur);
        }
        const points = [...bucket.entries()]
          .sort((x, y) => x[0].localeCompare(y[0]))
          .map(([date, v]) => ({ date, net: Math.round(v.net * 100) / 100, gross: Math.round(v.gross * 100) / 100, refunds: Math.round(v.refunds * 100) / 100 }));
        const totalNet = points.reduce((s, p) => s + p.net, 0);
        const summary = `Daily net sales — last ${days} days · ${rows.length} orders · ${money(totalNet)}${caveatIfCapped(rows.length, hitCap, "orders")}`;
        return ok(name, args, { points, ordersCount: rows.length, capped: hitCap }, summary);
      }

      // ── chart_top_products_by_units ───────────────────────────────────────────
      case "chart_top_products_by_units": {
        const a = schemas.chart_top_products_by_units.parse(args);
        const days = a.days ?? 30;
        const limit = a.limit ?? 10;
        const filter = `processed_at:>=-${days}d`;
        interface LineRow { quantity: number; product: { title: string } | null }
        interface OrdersConn { orders: { edges: Array<{ node: { lineItems: { edges: Array<{ node: LineRow }> } } }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
        const counts = new Map<string, number>();
        let totalLines = 0, page = 0, hitCap = false;
        let cursor: string | null = null;
        while (page < MAX_PAGES) {
          const data = await gql<OrdersConn>(ctx.admin, `#graphql
            query TopProductsPages($first: Int!, $query: String!, $after: String) {
              orders(first: $first, query: $query, sortKey: PROCESSED_AT, after: $after) {
                edges { node { lineItems(first: 100) { edges { node { quantity product { title } } } } } }
                pageInfo { hasNextPage endCursor }
              }
            }`, { first: PAGE_SIZE, query: filter, after: cursor });
          for (const o of data.orders.edges) {
            for (const li of o.node.lineItems.edges) {
              const title = li.node.product?.title ?? "Unknown product";
              counts.set(title, (counts.get(title) ?? 0) + (li.node.quantity ?? 0));
              totalLines++;
            }
          }
          if (!data.orders.pageInfo.hasNextPage || !data.orders.pageInfo.endCursor) break;
          cursor = data.orders.pageInfo.endCursor;
          page++;
          if (page >= MAX_PAGES) hitCap = true;
        }
        const bars = [...counts.entries()]
          .map(([name, qty]) => ({ name, qty }))
          .sort((x, y) => y.qty - x.qty)
          .slice(0, limit);
        const top = bars[0];
        const summary = `Top ${bars.length} products by units sold — last ${days} days · ${totalLines} line items${caveatIfCapped(totalLines, hitCap, "orders")}${top ? ` · #1 ${top.name} (${top.qty})` : ""}`;
        return ok(name, args, { bars, totalLines, capped: hitCap }, summary);
      }

      // ── chart_revenue_by_dimension ────────────────────────────────────────────
      case "chart_revenue_by_dimension": {
        const a = schemas.chart_revenue_by_dimension.parse(args);
        const days = a.days ?? 30;

        // ── ShopifyQL path (preferred) for product_type or vendor (the only
        //    dimensions ShopifyQL exposes natively on the sales schema). status
        //    and fulfillment_status fall through to raw pagination below.
        const qlDim = a.dimension === "product_type" ? "product_type"
          : a.dimension === "vendor" ? "vendor"
          : null;
        if (qlDim) {
          const qlRev = await runShopifyQL(ctx.admin, `FROM sales SHOW total_sales BY ${qlDim} SINCE -${days}d`);
          if (qlRev?.rows?.length && qlRev.columns?.length >= 2) {
            const iLabel = qlRev.columns.findIndex((c) => /product_type|vendor|product|vendor/i.test(c.toLowerCase()));
            const iVal = qlRev.columns.findIndex((c) => /sales|revenue|total_sales/i.test(c.toLowerCase()));
            if (iLabel >= 0 && iVal >= 0) {
              const slices = qlRev.rows
                .map((r) => ({ label: String(r[iLabel] ?? "Unknown"), value: Math.round(toNumber(r[iVal]) * 100) / 100 }))
                .filter((s) => s.value > 0)
                .sort((x, y) => y.value - x.value);
              const total = slices.reduce((s, x) => s + x.value, 0);
              const top = slices[0];
              const summary = `Revenue by ${a.dimension} — last ${days} days · ${slices.length} groups · ${money(total)} total${top ? ` · #1 ${top.label}` : ""}`;
              return ok(name, args, { slices, dimension: a.dimension, total, capped: false, viaSageQL: true }, summary);
            }
          }
        }

        // ── Fallback: raw order pagination (status / fulfillment_status, or
        //    if ShopifyQL path returned null for any reason above) ────────────────
        const filter = `processed_at:>=-${days}d`;
        interface LineRow { quantity: number; originalUnitPriceSet: { shopMoney: { amount: string } } | null; product: { productType: string; vendor: string; status: string } | null }
        interface OrdersConn { orders: { edges: Array<{ node: { displayFulfillmentStatus: string; lineItems: { edges: Array<{ node: LineRow }> } } }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
        const buckets = new Map<string, number>();
        let linesN = 0, page = 0, hitCap = false, cursor: string | null = null;
        while (page < MAX_PAGES) {
          const data = await gql<OrdersConn>(ctx.admin, `#graphql
            query RevByDim($first: Int!, $query: String!, $after: String) {
              orders(first: $first, query: $query, sortKey: PROCESSED_AT, after: $after) {
                edges { node { displayFulfillmentStatus lineItems(first: 100) { edges { node { quantity originalUnitPriceSet { shopMoney { amount } } product { productType vendor status } } } } } }
                pageInfo { hasNextPage endCursor }
              }
            }`, { first: PAGE_SIZE, query: filter, after: cursor });
          for (const o of data.orders.edges) {
            for (const li of o.node.lineItems.edges) {
              const price = sumMoney([li.node.originalUnitPriceSet?.shopMoney?.amount]);
              const revenue = price * (li.node.quantity ?? 0);
              let label = "Unknown";
              const p = li.node.product;
              switch (a.dimension) {
                case "product_type": label = p?.productType || "Other"; break;
                case "vendor": label = p?.vendor || "Other"; break;
                case "status": label = p?.status || "UNKNOWN"; break;
                case "fulfillment_status": label = o.node.displayFulfillmentStatus || "UNKNOWN"; break;
              }
              buckets.set(label, (buckets.get(label) ?? 0) + revenue);
              linesN++;
            }
          }
          if (!data.orders.pageInfo.hasNextPage || !data.orders.pageInfo.endCursor) break;
          cursor = data.orders.pageInfo.endCursor;
          page++;
          if (page >= MAX_PAGES) hitCap = true;
        }
        const slices = [...buckets.entries()]
          .map(([label, value]) => ({ label, value: Math.round(value * 100) / 100 }))
          .sort((x, y) => y.value - x.value);
        const total = slices.reduce((s, x) => s + x.value, 0);
        const top = slices[0];
        const summary = `Revenue by ${a.dimension} — last ${days} days · ${slices.length} ${a.dimension}s${caveatIfCapped(linesN, hitCap, "orders")} · ${money(total)} total${top ? ` · #1 ${top.label}` : ""}`;
        return ok(name, args, { slices, dimension: a.dimension, total, capped: hitCap }, summary);
      }

      // ── chart_inventory_distribution ───────────────────────────────────────────
      case "chart_inventory_distribution": {
        const a = schemas.chart_inventory_distribution.parse(args);
        interface ProdRow { id: string; status: string; productType: string; vendor: string; totalInventory: number }
        interface ProductsConn { products: { edges: Array<{ node: ProdRow }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
        const buckets = new Map<string, number>();
        let total = 0, page = 0, hitCap = false, cursor: string | null = null;
        while (page < MAX_PAGES) {
          const data = await gql<ProductsConn>(ctx.admin, `#graphql
            query InvDist($first: Int!, $after: String) {
              products(first: $first, after: $after) {
                edges { node { id status productType vendor totalInventory } }
                pageInfo { hasNextPage endCursor }
              }
            }`, { first: PAGE_SIZE, after: cursor });
          for (const e of data.products.edges) {
            const n = e.node;
            total++;
            let label = "Other";
            switch (a.dimension) {
              case "status": label = n.status || "UNKNOWN"; break;
              case "product_type": label = n.productType || "Other"; break;
              case "vendor": label = n.vendor || "Other"; break;
              case "stock_health":
                label = n.totalInventory <= 0 ? "Out of stock"
                  : n.totalInventory <= 5 ? "Low stock"
                  : "In stock";
                break;
            }
            buckets.set(label, (buckets.get(label) ?? 0) + 1);
          }
          if (!data.products.pageInfo.hasNextPage || !data.products.pageInfo.endCursor) break;
          cursor = data.products.pageInfo.endCursor;
          page++;
          if (page >= MAX_PAGES) hitCap = true;
        }
        const slices = [...buckets.entries()]
          .map(([label, value]) => ({ label, value }))
          .sort((x, y) => y.value - x.value);
        const summary = `Inventory by ${a.dimension} · ${total} products${caveatIfCapped(total, hitCap, "products")} · ${slices.length} ${a.dimension}s`;
        return ok(name, args, { slices, dimension: a.dimension, total, capped: hitCap }, summary);
      }

      // ── chart_new_customers_over_time ──────────────────────────────────────────
      case "chart_new_customers_over_time": {
        const a = schemas.chart_new_customers_over_time.parse(args);
        const days = a.days ?? 90;
        // Shopify's `customers` query filter for "customer created since X" is
        // `created_at:>=<date>`, which — like `processed_at` on the orders
        // query — accepts relative syntax (`-90d`). The earlier `customer_date`
        // attempt threw "Invalid timestamp for query filter `customer_date`,"
        // because that filter name belongs to a different (REST-style) surface.
        const filter = `created_at:>=-${days}d`;
        interface CustRow { createdAt: string }
        interface CustomersConn { customers: { edges: Array<{ node: CustRow }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
        const counts = new Map<string, number>();
        let total = 0, page = 0, hitCap = false, cursor: string | null = null;
        while (page < MAX_PAGES) {
          const data = await gql<CustomersConn>(ctx.admin, `#graphql
            query NewCustomersPages($first: Int!, $query: String!, $after: String) {
              customers(first: $first, query: $query, sortKey: CREATED_AT, after: $after) {
                edges { node { createdAt } }
                pageInfo { hasNextPage endCursor }
              }
            }`, { first: PAGE_SIZE, query: filter, after: cursor });
          for (const e of data.customers.edges) {
            const k = bucketKey(e.node.createdAt, days);
            counts.set(k, (counts.get(k) ?? 0) + 1);
            total++;
          }
          if (!data.customers.pageInfo.hasNextPage || !data.customers.pageInfo.endCursor) break;
          cursor = data.customers.pageInfo.endCursor;
          page++;
          if (page >= MAX_PAGES) hitCap = true;
        }
        const points = [...counts.entries()]
          .sort((x, y) => x[0].localeCompare(y[0]))
          .map(([date, count]) => ({ date, count }));
        const summary = `New customers — last ${days} days · ${total} total${caveatIfCapped(total, hitCap, "customers")}`;
        return ok(name, args, { points, total, capped: hitCap }, summary);
      }

      // ── chart_top_discounts_by_usage ───────────────────────────────────────────
      case "chart_top_discounts_by_usage": {
        const a = schemas.chart_top_discounts_by_usage.parse(args);
        const limit = a.limit ?? 8;
        interface PriceRuleRow { title: string; usageCount: number; totalSales: { amount: string } | null; status: string }
        interface PriceRulesData { priceRules: { edges: Array<{ node: PriceRuleRow }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
        const rows: PriceRuleRow[] = [];
        let page = 0, cursor: string | null = null;
        while (page < 2) { // discounts rarely exceed a few rows; cap at 2 pages
          const data = await gql<PriceRulesData>(ctx.admin, `#graphql
            query PriceRules($first: Int!, $after: String) {
              priceRules(first: $first, after: $after) {
                edges { node { title usageCount totalSales { amount } status } }
                pageInfo { hasNextPage endCursor }
              }
            }`, { first: Math.min(100, PAGE_SIZE), after: cursor });
          for (const e of data.priceRules.edges) rows.push(e.node);
          if (!data.priceRules.pageInfo.hasNextPage || !data.priceRules.pageInfo.endCursor) break;
          cursor = data.priceRules.pageInfo.endCursor;
          page++;
        }
        const bars = rows
          .map((r) => ({ name: r.title || "Untitled", usage: r.usageCount ?? 0, sales: sumMoney([r.totalSales?.amount]), status: r.status }))
          .sort((x, y) => y.usage - x.usage)
          .slice(0, limit);
        const top = bars[0];
        const summary = `Top ${bars.length} discounts by usage · ${rows.length} total rules${top ? ` · #1 ${top.name} (${top.usage} uses)` : ""}`;
        return ok(name, args, { bars, totalRules: rows.length }, summary);
      }

      default:
        return fail(name, args, `Unknown tool: ${name}`, `Unknown tool: ${name}`);
    }
  } catch (e) {
    const msg = (e as Error).message;
    // 1) Protected customer data — the merchant (or Shopify Partner Dashboard)
    //    has NOT approved the app for Customer data. This is a distinct failure
    //    mode: read_customers scope IS granted, but the app's distribution
    //    hasn't cleared Shopify's protected-customer-data access policy
    //    (https://shopify.dev/docs/apps/launch/protected-customer-data).
    //    The fix is in Partner Dashboard → API access → Protected customer data
    //    access, NOT a re-auth prompt.
    if (/not approved to access the Customer/i.test(msg) || /protected customer data/i.test(msg)) {
      return fail(
        name, args,
        "This app is not approved to read Customer data. Shopify treats customer records as protected. Open the app in your Shopify Partner Dashboard → API access → Protected customer data access, request the customers read access, then re-open the app in Shopify admin. The read_customers scope is already in .env — the gate is a separate approval policy.",
        "Customer data access pending Partner-Dashboard approval",
      );
    }
    // 2) Plain scope re-auth needed (read_orders missing / etc.).
    if (/access denied|FORBIDDEN|Requires access scope|read_orders/i.test(msg)) {
      return fail(name, args, scopeError("read_orders (or the relevant scope)"), `Chart unavailable — needs scope re-auth`);
    }
    // 3) read_customers scope itself missing (different message from 1) — the
    //    app does not even request read_customers. Today this shouldn't fire
    //    because SCOPES includes read_customers, but we keep the trap for
    //    safety in case the env line is later trimmed.
    if (/read_customers|cannot access.*Customer/i.test(msg)) {
      return fail(name, args, scopeError("read_customers"), `Chart unavailable — needs scope re-auth`);
    }
    // 4) Discount / price rules / reports scope missing.
    if (/read_discounts|read_price_rules|read_reports/i.test(msg)) {
      return fail(name, args, scopeError("read_discounts / read_price_rules / read_reports"), `Chart unavailable — needs scope re-auth`);
    }
    return fail(name, args, msg, `Tool ${name} failed`);
  }
}

function ok(name: string, args: Record<string, unknown>, result: unknown, summary: string): ToolResult {
  return { name, args, result, summary, ok: true };
}
function fail(name: string, args: Record<string, unknown>, error: string, summary: string): ToolResult {
  return { name, args, result: null, summary, ok: false, error };
}

/**
 * Build a transparent, merchant-readable summary of a product list result.
 * Shows the count AND up to the first few product names + their statuses, so
 * the merchant can sanity-check what the search actually returned instead of
 * staring at an opaque "Found 18 product(s)" with no insight into which 18.
 *
 * Examples:
 *   []                                 → "No products matched."
 *   [{title:'A',status:'ARCHIVED'}]    → "Found 1 product: A (ARCHIVED)."
 *   [4 products]                       → "Found 4 products: A (ARCHIVED), B (ARCHIVED), C (ARCHIVED), +1 more."
 */
function summarizeProductList(
  products: Array<{ title?: string; status?: string; minInventory?: number }>,
  contextLabel?: string,
): string {
  const n = products.length;
  if (n === 0) {
    return contextLabel
      ? `No products matched ${contextLabel}.`
      : "No products matched.";
  }
  const SHOW = 3; // cap inline names to keep the chip readable
  const head = products.slice(0, SHOW).map((p) => {
    const title = p.title ?? "Untitled";
    const meta = typeof p.minInventory === "number"
      ? `${p.minInventory} units`                              // low-stock context
      : (p.status ? p.status : "");                            // status context
    return meta ? `${title} (${meta})` : title;
  });
  const more = n > SHOW ? `, +${n - SHOW} more` : "";
  const plural = n === 1 ? "product" : "products";
  const ctx = contextLabel ? ` matching ${contextLabel}` : "";
  return `Found ${n} ${plural}${ctx}: ${head.join(", ")}${more}.`;
}

/**
 * One-line human-readable description of what a proposed write would do if
 * approved. Used by the agent loop to populate pending-write Approve cards.
 * Falls back to the tool name when args are missing/unknown.
 */
export function describeWriteCall(name: string, args: Record<string, unknown>): string {
  const a = args ?? {};
  const tail = (gid: unknown) => (typeof gid === "string" ? gid.split("/").pop() ?? gid : gid);
  switch (name) {
    case "set_product_status": {
      const status = String(a.status ?? "?").toUpperCase();
      // Friendlier verbs for the Approve card so the merchant reads intent, not enum.
      const verb = status === "DRAFT" ? "DRAFT (unavailable)"
        : status === "ARCHIVED" ? "ARCHIVED (no longer sold)"
        : status === "UNLISTED" ? "UNLISTED (direct-link only)"
        : status;
      return `Mark product ${tail(a.productId)} as ${verb}`;
    }
    case "update_price":
      return `Set price of variant ${tail(a.variantId)} to $${a.price ?? "?"}`;
    case "update_inventory":
      return `Set inventory of variant ${tail(a.variantId)} to ${a.available ?? "?"} units`;
    default:
      return `Run ${name}`;
  }
}
