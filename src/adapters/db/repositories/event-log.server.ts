import { Prisma } from "@prisma/client";

import { prisma } from "~/adapters/db/client.server";
import { shopDomainOf, type Principal } from "~/domain/types";

type Tx = Prisma.TransactionClient;

export interface EventEntry {
  entityType: string;
  entityId?: string;
  event: string;
  detail?: Prisma.InputJsonValue;
}

/**
 * Append-only (CLAUDE.md section 6). There is deliberately no update and no
 * delete here: the only thing that ever removes rows is the section 2.4
 * retention job, and it redacts PII rather than dropping the decision trail.
 */
export async function appendEvent(
  principal: Principal,
  entry: EventEntry,
  tx: Tx | typeof prisma = prisma,
): Promise<void> {
  const domain = shopDomainOf(principal);

  const shop = await tx.shop.findUnique({
    where: { domain },
    select: { id: true },
  });

  // A webhook can arrive after the shop row is gone (uninstall, then redact).
  // Losing the log line is correct here: there is no tenant left to own it.
  if (!shop) return;

  await tx.eventLog.create({
    data: {
      shopId: shop.id,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      event: entry.event,
      detail: entry.detail ?? Prisma.DbNull,
    },
  });
}

export async function recentEvents(principal: Principal, limit = 20) {
  const domain = shopDomainOf(principal);

  return prisma.eventLog.findMany({
    where: { shop: { domain } },
    orderBy: { at: "desc" },
    take: limit,
  });
}
