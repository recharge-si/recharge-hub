import type { Queue } from "pg-boss";

/**
 * Queue names and their retry policy. Shared by the producer (adapters/queue) and
 * the consumer (jobs/), so both agree on spelling and on how often a job retries.
 *
 * In pg-boss 12 retry settings belong to the queue, not to the individual send.
 */
export const QUEUES = {
  appUninstalled: "app-uninstalled",
  customersDataRequest: "customers-data-request",
  customersRedact: "customers-redact",
  shopRedact: "shop-redact",
  syncCatalogue: "sync-catalogue",
  syncInventory: "sync-inventory",
  syncProducts: "sync-products",
  reloadWarehouses: "reload-warehouses",
  reloadPaymentTypes: "reload-payment-types",
  reloadProfitCenters: "reload-profit-centers",
  ordersCreate: "orders-create",
  allocateOrder: "allocate-order",
  writeMetakockaOrder: "write-metakocka-order",
  writeShopifyFulfilment: "write-shopify-fulfilment",
  ordersEvent: "orders-event",
  redactOldOrders: "redact-old-orders",
  scheduledTick: "scheduled-tick",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

type QueueOptions = Omit<Queue, "name">;

/**
 * Retryable failures back off exponentially and are never surfaced to a human
 * (CLAUDE.md section 11). Compliance work retries for well over a day because
 * failing to redact is not an option we get to take.
 */
const COMPLIANCE_POLICY: QueueOptions = {
  retryLimit: 12,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 3600,
  expireInSeconds: 300,
  retentionSeconds: 60 * 60 * 24 * 30,
};

export const QUEUE_DEFINITIONS: Record<QueueName, QueueOptions> = {
  [QUEUES.appUninstalled]: {
    retryLimit: 6,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 300,
  },
  // Sync work is safe to retry: it reads both sides and writes only what
  // differs, so a repeat run is a no-op rather than a duplicate.
  // No `policy` here on purpose. pg-boss refuses to change a queue's policy
  // after creation, so setting one would behave differently on a fresh database
  // than on an existing one. Stacking is prevented at send time instead, with
  // `enqueueThrottled`.
  [QUEUES.syncCatalogue]: {
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 1800,
  },
  [QUEUES.syncInventory]: {
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 1800,
  },
  // One MetaKocka call per product and no bulk endpoint (§8.9), so a full
  // catalogue push is measured in minutes, not seconds.
  [QUEUES.syncProducts]: {
    retryLimit: 2,
    retryDelay: 120,
    retryBackoff: true,
    expireInSeconds: 7200,
  },
  // Order intake. The webhook already wrote the order row inside its own
  // transaction, so this queue exists for the events that only raise an
  // exception (refunds, cancellations, edits) and for re-parsing.
  [QUEUES.ordersCreate]: {
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 300,
  },
  [QUEUES.ordersEvent]: {
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 300,
  },
  // Pure and fast: it reads stock and rules and decides. Worth retrying, since
  // a failure here is almost always the database being briefly unavailable.
  [QUEUES.allocateOrder]: {
    retryLimit: 5,
    retryDelay: 15,
    retryBackoff: true,
    expireInSeconds: 300,
  },
  // Writes into the ERP. Retries are safe only because the count_code row is
  // claimed before the call goes out (section 8.4): MetaKocka would otherwise
  // happily create a second document.
  [QUEUES.writeMetakockaOrder]: {
    retryLimit: 4,
    retryDelay: 60,
    retryBackoff: true,
    // Kept in step with CLAIM_LEASE_MS in the order repository: a claim may be
    // taken over only once pg-boss has abandoned the job holding it.
    expireInSeconds: 300,
  },
  [QUEUES.writeShopifyFulfilment]: {
    retryLimit: 4,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 600,
  },
  // Small and cheap. Worth retrying a few times, never worth a human looking.
  [QUEUES.reloadWarehouses]: {
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 300,
  },
  // Same shape as the warehouse reload, and equally invisible to the merchant.
  [QUEUES.reloadPaymentTypes]: {
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 300,
  },
  // One probe per registered profit centre plus a control, so it is slower than
  // the payment type reload it otherwise mirrors. Still small, still invisible.
  [QUEUES.reloadProfitCenters]: {
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 900,
  },
  // The cron fan-out itself does no work beyond a query and a few sends, so a
  // failed tick is better dropped than retried into the next one.
  [QUEUES.scheduledTick]: {
    retryLimit: 1,
    retryDelay: 30,
    expireInSeconds: 300,
    retentionSeconds: 60 * 60 * 24,
  },
  // A retention promise, so it retries like the other compliance work rather
  // than being dropped after a couple of attempts.
  [QUEUES.redactOldOrders]: COMPLIANCE_POLICY,
  [QUEUES.customersDataRequest]: COMPLIANCE_POLICY,
  [QUEUES.customersRedact]: COMPLIANCE_POLICY,
  [QUEUES.shopRedact]: COMPLIANCE_POLICY,
};

export const ALL_QUEUES: QueueName[] = Object.values(QUEUES);
