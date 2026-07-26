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
    description: "Set a product's status to ACTIVE or DRAFT (DRAFT makes the product unavailable/unlisted). WRITE — Reeve will PROPOSE this; the merchant must approve before it runs. Needs a productId (from get_low_stock_products/get_products results).",
    args: { productId: "string", status: "ACTIVE|DRAFT" },
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
  set_product_status: z.object({ productId: z.string(), status: z.enum(["ACTIVE", "DRAFT"]) }),
  update_price: z.object({ variantId: z.string(), price: z.string() }),
  summarize_inventory: z.object({}).strict(),
} as const;

export type ToolName = keyof typeof schemas;

// ─── GraphQL helpers ────────────────────────────────────────────────────────────

async function gql<T>(admin: AdminClient, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await admin.graphql(query, variables ? { variables } : undefined);
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data as T;
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

      default:
        return fail(name, args, `Unknown tool: ${name}`, `Unknown tool: ${name}`);
    }
  } catch (e) {
    return fail(name, args, (e as Error).message, `Tool ${name} failed`);
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
      const status = String(a.status ?? "?");
      const verb = status.toUpperCase() === "DRAFT" ? "unavailable (DRAFT)" : status;
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
