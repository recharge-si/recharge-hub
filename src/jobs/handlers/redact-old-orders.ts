import type { Job } from "pg-boss";
import { z } from "zod";

import { Prisma } from "@prisma/client";

import { prisma } from "~/adapters/db/client.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { redactTaxSnapshot } from "~/adapters/db/repositories/tax.server";
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
 * Where a field called `name` is a thing rather than a person.
 *
 * `name` used to be blanked wherever it appeared, which took `order.name`
 * ("#1042"), every line item's name ("Carbon mast - Blue") and every MetaKocka
 * `product_list` name with it. None of those is personal data, all three are
 * the decision trail §2.4 promises to keep, and the order screen and the diff
 * both read them — so a redacted order stopped being able to say what was on
 * it.
 *
 * A person's name is still blanked everywhere else, and the containers that
 * actually hold one — `customer`, `billing_address`, `shipping_address` — are
 * blanked whole rather than field by field, so nothing depends on this list
 * being complete in the other direction.
 *
 * `null` is the payload's own root: the order object itself.
 */
const NAME_IS_NOT_A_PERSON: ReadonlySet<string | null> = new Set([
  null,
  "line_items",
  "product_list",
  "shipping_lines",
  "tax_lines",
  "discount_codes",
  "attachment_list",
]);

function isPersonal(key: string, container: string | null): boolean {
  if (key === "name") return !NAME_IS_NOT_A_PERSON.has(container);
  return PII_KEYS.has(key);
}

/**
 * Walks a payload and blanks anything personal, keeping the structure so the
 * order page can still say what it always said about quantities and codes.
 *
 * `product_list`, `line_items` and their SKUs are untouched by design: they are
 * the decision trail, not the customer.
 *
 * `container` is the key this value was found under — the enclosing array's
 * key for an array entry — which is how a name can be judged by where it is
 * rather than by what it is called.
 */
export function redactPayload(
  value: unknown,
  depth = 0,
  container: string | null = null,
): unknown {
  if (depth > 12) return value;
  if (Array.isArray(value)) {
    // An entry keeps its array's key: a line item is still "in line_items".
    return value.map((entry) => redactPayload(entry, depth + 1, container));
  }
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isPersonal(key, container)) {
      out[key] = entry === null || entry === undefined ? entry : "[redacted]";
      continue;
    }
    out[key] = redactPayload(entry, depth + 1, key);
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
          // Customer details a merchant typed in by hand (§11) are the same
          // promise as the payload — savePartnerOverride says so explicitly —
          // and unlike the payload there is nothing non-personal in them to
          // keep, so the column is dropped rather than walked.
          partnerOverride: Prisma.DbNull,
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

    // The tax decision keeps its rates, amounts and reasons; only the VAT
    // identifier — a business's, and for a sole trader a person's — goes.
    await redactTaxSnapshot(order.id);

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
