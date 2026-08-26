import type { Job } from "pg-boss";

import { prisma } from "~/adapters/db/client.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { getLogger } from "~/adapters/observability/logger.server";
import {
  customersDataRequestSchema,
  webhookJobSchema,
} from "~/adapters/shopify/compliance-payloads";
import { serviceToken, shopDomainOf } from "~/domain/types";

/**
 * A merchant asked what this app holds about one of their customers. Shopify
 * requires the merchant to be given that data within 30 days. The app records
 * the request so the operator can answer it, and never contacts the customer
 * directly.
 *
 * What is recorded is an honest inventory, not the data itself: which of the
 * requested orders this app still holds, whether their payloads are already
 * redacted, how many ERP request bodies exist beside them, and whether any
 * carry hand-typed customer details. The event log is the §2.4 audit trail and
 * outlives the payloads, so the inventory names orders by their Shopify id —
 * never by the person.
 */
export async function handleCustomersDataRequest(
  job: Job<unknown>,
): Promise<void> {
  const envelope = webhookJobSchema.parse(job.data);
  const payload = customersDataRequestSchema.parse(envelope.payload);
  const principal = serviceToken(payload.shop_domain, "customers-data-request");
  const domain = shopDomainOf(principal);

  const requestedIds = payload.orders_requested.map(String);

  const held =
    requestedIds.length > 0
      ? await prisma.order.findMany({
          where: { shop: { domain }, shopifyOrderId: { in: requestedIds } },
          select: {
            shopifyOrderId: true,
            redactedAt: true,
            partnerOverride: true,
            _count: { select: { documents: true } },
          },
        })
      : [];

  const documentsHeld = held.reduce(
    (sum, order) => sum + order._count.documents,
    0,
  );
  const withOverride = held.filter(
    (order) => order.partnerOverride !== null,
  ).length;
  const alreadyRedacted = held.filter(
    (order) => order.redactedAt !== null,
  ).length;

  await appendEvent(principal, {
    entityType: "customer",
    entityId: payload.customer.id ? String(payload.customer.id) : undefined,
    event: "compliance.customers_data_request",
    detail: {
      webhookId: envelope.webhookId,
      requestId: payload.data_request?.id
        ? String(payload.data_request.id)
        : null,
      orderCount: payload.orders_requested.length,
      recordsHeld: held.length,
      documentsHeld,
      withPartnerOverride: withOverride,
      alreadyRedacted,
      heldOrderIds: held.map((order) => order.shopifyOrderId),
    },
  });

  getLogger().info(
    {
      shop: payload.shop_domain,
      webhookId: envelope.webhookId,
      requested: payload.orders_requested.length,
      held: held.length,
      documents: documentsHeld,
    },
    "customers/data_request recorded",
  );
}
