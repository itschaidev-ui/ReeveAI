// app/lib/audit.server.ts — append-only audit log for every agent action.
import prisma from "../db.server";

interface LogParams {
  shop: string;
  type: string;
  severity?: string;
  source?: string;
  message: string;
  before?: unknown;
  after?: unknown;
}

export async function logActivity(params: LogParams): Promise<void> {
  await prisma.activity.create({
    data: {
      shop: params.shop,
      type: params.type,
      severity: params.severity ?? "info",
      source: params.source ?? "agent",
      message: params.message,
      beforeJson: params.before ? JSON.stringify(params.before) : null,
      afterJson: params.after ? JSON.stringify(params.after) : null,
    },
  });
}

export async function getActivities(shop: string, limit = 50) {
  return prisma.activity.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
