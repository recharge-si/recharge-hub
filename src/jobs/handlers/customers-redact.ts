import type { Job } from "pg-boss";

import { Prisma } from "@prisma/client";

import { prisma } from "~/adapters/db/client.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { getLogger } from "~/adapters/observability/logger.server";
import {
  customersRedactSchema,
  webhookJobSchema,
} from "~/adapters/shopify/compliance-payloads";
import { redactPayload } from "~/jobs/handlers/redact-old-orders";
import { serviceToken, shopDomainOf } from "~/domain/types";

/**
 * CLAUDE.md section 2.4: this deletes, it does not soft-delete.
 *
 * Three places hold this customer, and all three are cleared:
 *
 *  - `order.raw_payload` — the Shopify order as it arrived, redacted in place
 *    with the same walker the 90-day retention job uses, so the decision trail
 *    (SKUs, quantities, totals) survives and the person does not.
 *  - `metakocka_document.request_body` — the body sent to the ERP, which
 *    carries the same partner and receiver.
 *  - `order.partner_override` — customer details a merchant typed in by hand
 *    for an order Shopify had no address on. Dropped outright: unlike the
 *    payload there is nothing non-personal in it to keep.
 *
 * The orders are the ones Shopify names in `orders_to_redact`. A second pass
 * matches any stored payload that still names the customer id, in case Shopify
 * and this database disagree about which orders the customer touched —
 * redacting one order too many is recoverable, missing one is not.
 */
export async function handleCustomersRedact(job: Job<unknown>): Promise<void> {
  const envelope = webhookJobSchema.parse(job.data);
  const payload = customersRedactSchema.parse(envelope.payload);
  const principal = serviceToken(payload.shop_domain, "customers-redact");
  const domain = shopDomainOf(principal);

  const namedIds = payload.orders_to_redact.map(String);

  const named =
    namedIds.length > 0
      ? await prisma.order.findMany({
          where: { shop: { domain }, shopifyOrderId: { in: namedIds } },
          select: { id: true, rawPayload: true },
        })
      : [];

  // Defence in depth: any order whose stored payload still names the customer,
  // whether or not Shopify listed it. The id can arrive as a number or string
  // and is stored however Shopify sent it, so both are asked.
  const customerId = payload.customer.id;
  const byCustomer =
    customerId === undefined || customerId === null
      ? []
      : await prisma.order.findMany({
          where: {
            shop: { domain },
            OR: [
              {
                rawPayload: {
                  path: ["customer", "id"],
                  equals: Number(customerId),
                },
              },
              {
                rawPayload: {
                  path: ["customer", "id"],
                  equals: String(customerId),
                },
              },
            ],
          },
          select: { id: true, rawPayload: true },
        });

  const due = new Map<string, { id: string; rawPayload: unknown }>();
  for (const order of [...named, ...byCustomer]) due.set(order.id, order);

  let documents = 0;

  for (const order of due.values()) {
    const redacted = order.rawPayload ? redactPayload(order.rawPayload) : null;

    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: {
          rawPayload: redacted as never,
          partnerOverride: Prisma.DbNull,
          redactedAt: new Date(),
        },
      });

      const docs = await tx.metakockaDocument.findMany({
        where: { orderId: order.id },
        select: { id: true, requestBody: true },
      });

      for (const document of docs) {
        if (!document.requestBody) continue;
        await tx.metakockaDocument.update({
          where: { id: document.id },
          data: {
            requestBody: redactPayload(document.requestBody) as never,
          },
        });
        documents += 1;
      }
    });
  }

  await appendEvent(principal, {
    entityType: "customer",
    // The Shopify customer id is not personal data on its own. The email and
    // phone in the payload are, and are deliberately not recorded.
    entityId: payload.customer.id ? String(payload.customer.id) : undefined,
    event: "compliance.customers_redact",
    detail: {
      webhookId: envelope.webhookId,
      orderCount: payload.orders_to_redact.length,
      redactedRecords: due.size,
      redactedDocuments: documents,
    },
  });

  getLogger().info(
    {
      shop: payload.shop_domain,
      webhookId: envelope.webhookId,
      orders: due.size,
      documents,
    },
    "customers/redact processed",
  );
}
