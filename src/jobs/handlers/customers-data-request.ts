import type { Job } from "pg-boss";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { getLogger } from "~/adapters/observability/logger.server";
import {
  customersDataRequestSchema,
  webhookJobSchema,
} from "~/adapters/shopify/compliance-payloads";
import { serviceToken } from "~/domain/types";

/**
 * A merchant asked what this app holds about one of their customers. Shopify
 * requires the merchant to be given that data within 30 days. The app records the
 * request so the operator can answer it, and never contacts the customer directly.
 *
 * M1 holds no customer data, so the honest answer is none. M4 extends this to
 * gather the order rows and MetaKocka documents for the requested orders.
 */
export async function handleCustomersDataRequest(
  job: Job<unknown>,
): Promise<void> {
  const envelope = webhookJobSchema.parse(job.data);
  const payload = customersDataRequestSchema.parse(envelope.payload);
  const principal = serviceToken(payload.shop_domain, "customers-data-request");

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
      recordsHeld: 0,
    },
  });

  getLogger().info(
    {
      shop: payload.shop_domain,
      webhookId: envelope.webhookId,
      orderCount: payload.orders_requested.length,
    },
    "customers/data_request processed, no stored customer records in this milestone",
  );
}
