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
    description: "List products in the store with their inventory counts and status. Optional filter by query text.",
    args: { query: "string?", limit: "number?" },
  },
  {
    name: "get_low_stock_products",
    description: "Return products whose inventory is at or below the given threshold (default 5).",
    args: { threshold: "number?" },
  },
  {
    name: "update_inventory",
    description: "Set a product variant's absolute inventory level at a location. Use after get_products to find the variant id + location id.",
    args: { variantId: "string", locationId: "string", available: "number" },
  },
  {
    name: "set_product_status",
    description: "Set a product's status (ACTIVE or DRAFT). Use DRAFT to make a product unavailable/unlisted.",
    args: { productId: "string", status: "ACTIVE|DRAFT" },
  },
  {
    name: "update_price",
    description: "Set a product variant's price in dollars (e.g. 49.99).",
    args: { variantId: "string", price: "string" },
  },
  {
    name: "summarize_inventory",
    description: "Return a synthesized health summary: total products, low-stock count, out-of-stock count.",
    args: {},
  },
];

// ─── Zod schemas for arg validation ────────────────────────────────────────────

const schemas = {
  get_products: z.object({ query: z.string().optional(), limit: z.number().int().min(1).max(250).optional() }),
  get_low_stock_products: z.object({ threshold: z.number().int().min(0).optional() }),
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
        return ok(name, args, products, `Found ${products.length} product(s)`);
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
        return ok(name, args, low, `Found ${low.length} product(s) at or below ${threshold} units`);
      }

      // ── update_inventory ──────────────────────────────────────────────────────
      case "update_inventory": {
        const a = schemas.update_inventory.parse(args);
        interface InvData { inventoryAdjustQuantities: { inventoryLevel: { available: number }; userErrors: unknown[] } }
        // Need the inventory item id for the variant — fetch it first.
        interface VarData { productVariant: { inventoryItem: { id: string } } }
        const varRes = await gql<{ productVariant: { inventoryItem?: { id: string } } }>(ctx.admin, `#graphql
          query VariantItem($id: ID!) { productVariant(id: $id) { inventoryItem { id } } }`, { id: a.variantId });
        const itemId = varRes.productVariant?.inventoryItem?.id;
        if (!itemId) throw new Error("Variant does not track inventory");
        const data = await gql<InvData>(ctx.admin, `#graphql
          mutation SetInventory($input: InventorySetQuantitiesInput!) {
            inventorySetOnHandQuantities(input: $input) {
              inventoryLevel { available }
              userErrors { field message }
            }
          }`, { input: { reason: "correction", setQuantities: [{ inventoryItemId: itemId, locationId: a.locationId, quantity: a.available }] } });
        const result = (data as unknown as { inventorySetOnHandQuantities: { inventoryLevel: { available: number }; userErrors: { message: string }[] } }).inventorySetOnHandQuantities;
        if (result.userErrors?.length) throw new Error(result.userErrors.map((e) => e.message).join(", "));
        await logActivity({ shop: ctx.shop, type: "inventory_update", severity: "success", message: `Set inventory to ${a.available} for variant ${a.variantId}`, after: { available: result.inventoryLevel.available } });
        return ok(name, args, { available: result.inventoryLevel.available }, `Set inventory to ${a.available}`);
      }

      // ── set_product_status ────────────────────────────────────────────────────
      case "set_product_status": {
        const a = schemas.set_product_status.parse(args);
        interface StatusData { productUpdate: { product: { id: string; status: string }; userErrors: { message: string }[] } }
        const data = await gql<StatusData>(ctx.admin, `#graphql
          mutation UpdateStatus($input: ProductUpdateInput!) {
            productUpdate(input: $input) { product { id status } userErrors { message } }
          }`, { input: { id: a.productId, status: a.status } });
        if (data.productUpdate.userErrors?.length) throw new Error(data.productUpdate.userErrors.map((e) => e.message).join(", "));
        await logActivity({ shop: ctx.shop, type: "availability_update", severity: "success", message: `Set product ${a.productId} status to ${a.status}`, after: { status: a.status } });
        return ok(name, args, { status: a.status }, `Set product status to ${a.status}`);
      }

      // ── update_price ──────────────────────────────────────────────────────────
      case "update_price": {
        const a = schemas.update_price.parse(args);
        interface PriceData { productVariantUpdate: { productVariant: { id: string; price: string }; userErrors: { message: string }[] } }
        const data = await gql<PriceData>(ctx.admin, `#graphql
          mutation UpdatePrice($input: ProductVariantInput!) {
            productVariantUpdate(input: $input) { productVariant { id price } userErrors { message } }
          }`, { input: { id: a.variantId, price: a.price } });
        if (data.productVariantUpdate.userErrors?.length) throw new Error(data.productVariantUpdate.userErrors.map((e) => e.message).join(", "));
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
