import type { Job } from "pg-boss";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { getLogger } from "~/adapters/observability/logger.server";
import {
  customersRedactSchema,
  webhookJobSchema,
} from "~/adapters/shopify/compliance-payloads";
import { serviceToken } from "~/domain/types";

/**
 * CLAUDE.md section 2.4: this deletes, it does not soft-delete.
 *
 * M1 stores no customer data at all -- the order tables arrive in M4 -- so there
 * is nothing to erase yet and this records that fact. When `order.raw_payload`
 * and `metakocka_document.request_body` exist, redacting them belongs here, and
 * the audit line it leaves behind still holds no PII.
 */
export async function handleCustomersRedact(job: Job<unknown>): Promise<void> {
  const envelope = webhookJobSchema.parse(job.data);
  const payload = customersRedactSchema.parse(envelope.payload);
  const principal = serviceToken(payload.shop_domain, "customers-redact");

  const orderCount = payload.orders_to_redact.length;

  await appendEvent(principal, {
    entityType: "customer",
    // The Shopify customer id is not personal data on its own. The email and
    // phone in the payload are, and are deliberately not recorded.
    entityId: payload.customer.id ? String(payload.customer.id) : undefined,
    event: "compliance.customers_redact",
    detail: { webhookId: envelope.webhookId, orderCount, redactedRecords: 0 },
  });

  getLogger().info(
    { shop: payload.shop_domain, webhookId: envelope.webhookId, orderCount },
    "customers/redact processed, no stored customer records in this milestone",
  );
}
