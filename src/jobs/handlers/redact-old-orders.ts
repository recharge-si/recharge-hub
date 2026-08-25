import type { Job } from "pg-boss";
import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { serviceToken } from "~/domain/types";

export const redactOldOrdersJobSchema = z.object({
  shopDomain: z.string().min(1),
  /** Injected so a test can age an order without waiting ninety days. */
  olderThanDays: z.number().int().positive().default(90),
});

/**
 * The retention job (CLAUDE.md §2.4).
 *
 * Order payloads carry Level 2 protected customer data and this app transmits
 * it to a third-party ERP, so the approved justification comes with a promise:
 * raw Shopify payloads and MetaKocka request bodies are kept 90 days, and then
 * the personal data goes.
 *
 * §2.4 also names the tension this resolves. "Keep everything forever for the
 * audit trail" and "delete personal data on a schedule" cannot both be true, so
 * the split is drawn deliberately: **the decision trail survives, the person
 * does not.** SKUs, quantities, sources, rule reasons and document ids stay
 * readable years later; names, emails, phone numbers and addresses are
 * overwritten in place.
 *
 * Redacting in place rather than deleting the row matters. Deleting the order
 * would take the allocations and documents with it, and with them every record
 * of why the ERP holds what it holds.
 */

/** Field names that carry a person, wherever they appear in a payload. */
const PII_KEYS = new Set([
  "email",
  "contact_email",
  "phone",
  "first_name",
  "last_name",
  "name",
  "customer",
  "address1",
  "address2",
  "street",
  "zip",
  "post_number",
  "city",
  "place",
  "province",
  "latitude",
  "longitude",
  "note",
  "note_attributes",
  "billing_address",
  "shipping_address",
  "default_address",
  "partner_contact",
  "tax_id_number",
  "client_details",
  "browser_ip",
]);

/**
 * Walks a payload and blanks anything personal, keeping the structure so the
 * order page can still say what it always said about quantities and codes.
 *
 * `product_list`, `line_items` and their SKUs are untouched by design: they are
 * the decision trail, not the customer.
 */
export function redactPayload(value: unknown, depth = 0): unknown {
  if (depth > 12) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => redactPayload(entry, depth + 1));
  }
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (PII_KEYS.has(key)) {
      out[key] = entry === null || entry === undefined ? entry : "[redacted]";
      continue;
    }
    out[key] = redactPayload(entry, depth + 1);
  }
  return out;
}

export async function handleRedactOldOrders(job: Job<unknown>): Promise<void> {
  const { shopDomain, olderThanDays } = redactOldOrdersJobSchema.parse(
    job.data ?? {},
  );
  const principal = serviceToken(shopDomain, "redact-old-orders");
  const log = getLogger();

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - olderThanDays);

  const due = await prisma.order.findMany({
    where: {
      shop: { domain: shopDomain },
      receivedAt: { lt: cutoff },
      redactedAt: null,
    },
    select: { id: true, rawPayload: true },
    // Bounded, so one run cannot lock the table for a large catalogue. The
    // schedule comes round again and takes the next batch.
    take: 500,
  });

  if (due.length === 0) return;

  let orders = 0;
  let documents = 0;

  for (const order of due) {
    const redacted = order.rawPayload ? redactPayload(order.rawPayload) : null;

    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: {
          rawPayload: redacted as never,
          redactedAt: new Date(),
        },
      });

      // The request bodies sent to MetaKocka carry the same partner and
      // receiver, so they are covered by the same promise.
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

    orders += 1;
  }

  await appendEvent(principal, {
    entityType: "order",
    event: "orders.redacted",
    detail: { orders, documents, olderThanDays },
  });

  log.info(
    { shop: shopDomain, orders, documents },
    "Redacted personal data from old orders",
  );
}
