import type { Queue } from "pg-boss";

/**
 * Queue names and their retry policy. Shared by the producer (adapters/queue) and
 * the consumer (jobs/), so both agree on spelling and on how often a job retries.
 *
 * In pg-boss 12 retry settings belong to the queue, not to the individual send.
 */
export const QUEUES = {
  // First on purpose: `ensureQueues` creates queues in this order, and the
  // dead-letter target has to exist before any queue that names it.
  deadJobs: "dead-jobs",
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
  reloadPricelists: "reload-pricelists",
  reconcileOrder: "reconcile-order",
  allocateOrder: "allocate-order",
  writeMetakockaOrder: "write-metakocka-order",
  writeShopifyFulfilment: "write-shopify-fulfilment",
  ordersEvent: "orders-event",
  syncOrderState: "sync-order-state",
  markMetakockaPaid: "mark-metakocka-paid",
  reconcileOrders: "reconcile-orders",
  recheckExceptions: "recheck-exceptions",
  pollMetakockaDocuments: "poll-metakocka-documents",
  redactOldOrders: "redact-old-orders",
  scheduledTick: "scheduled-tick",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

type QueueOptions = Omit<Queue, "name">;

/**
 * Where a job goes when its last retry fails.
 *
 * §11 promises that a retryable failure needs no human *because the queue is
 * dealing with it* — a job that has run out of retries is no longer being
 * dealt with, and without this it vanished into pg-boss's failed state with
 * nothing telling the merchant. The dead-letter consumer raises an exception
 * instead (jobs/handlers/dead-job.ts).
 *
 * The scheduled ticks and the nightly register reloads are deliberately not
 * dead-lettered: the next tick re-runs them regardless, so their failure is
 * a Sentry event rather than a merchant-facing condition.
 */
const DEAD_LETTER = QUEUES.deadJobs;

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
  // Failing to redact is a legal promise broken; it must never fail silently.
  deadLetter: DEAD_LETTER,
};

export const QUEUE_DEFINITIONS: Record<QueueName, QueueOptions> = {
  // Consumes what every other queue dead-letters. Raising the exception is a
  // single insert, so a failure here is almost always the database being
  // briefly unavailable — worth a few retries, kept long enough to inspect.
  [QUEUES.deadJobs]: {
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 300,
    retentionSeconds: 60 * 60 * 24 * 14,
  },
  [QUEUES.appUninstalled]: {
    deadLetter: DEAD_LETTER,
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
    deadLetter: DEAD_LETTER,
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 1800,
  },
  [QUEUES.syncInventory]: {
    deadLetter: DEAD_LETTER,
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 1800,
  },
  // One MetaKocka call per product and no bulk endpoint (§8.9), so a full
  // catalogue push is measured in minutes, not seconds.
  [QUEUES.syncProducts]: {
    deadLetter: DEAD_LETTER,
    retryLimit: 2,
    retryDelay: 120,
    retryBackoff: true,
    expireInSeconds: 7200,
  },
  [QUEUES.ordersEvent]: {
    deadLetter: DEAD_LETTER,
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 300,
  },
  // Everything that happens to an order after it arrives. Cheap and idempotent
  // — the diff does nothing for an order that has not moved — so it retries
  // freely.
  [QUEUES.syncOrderState]: {
    deadLetter: DEAD_LETTER,
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 300,
  },
  // Recording a payment in the ERP. Retrying is safe only because each document
  // is claimed before the call and `payment_marked_at` is written after
  // (§8.7: mark_paid on an update replaces the previous payment).
  [QUEUES.markMetakockaPaid]: {
    deadLetter: DEAD_LETTER,
    retryLimit: 4,
    retryDelay: 60,
    retryBackoff: true,
    // Kept in step with PAYMENT_CLAIM_LEASE_MS in the order repository.
    expireInSeconds: 300,
  },
  // Re-reads every open exception and closes or re-drives it. Pure database
  // work, so it is cheap enough to run every quarter of an hour; a dropped run
  // costs nothing because the next one sees the same state.
  [QUEUES.recheckExceptions]: {
    retryLimit: 2,
    retryDelay: 60,
    retryBackoff: true,
    expireInSeconds: 600,
  },
  // Asks MetaKocka what became of the documents this app wrote. Several calls
  // and MetaKocka is slow (§3), so it gets a long window and a short leash.
  [QUEUES.pollMetakockaDocuments]: {
    retryLimit: 2,
    retryDelay: 120,
    retryBackoff: true,
    expireInSeconds: 1800,
  },
  // Reads pages of orders back from Shopify. Bounded per run, and the watermark
  // only advances over work that was actually done, so a dropped run costs a
  // repeat rather than a gap.
  [QUEUES.reconcileOrders]: {
    retryLimit: 2,
    retryDelay: 120,
    retryBackoff: true,
    expireInSeconds: 1800,
  },
  /*
   * The reconciliation loop for one order (the order-reconciliation brief
   * §12, §13).
   *
   * Everything an order event can mean funnels through here: read Shopify,
   * work out what MetaKocka should hold, change only the difference, verify.
   * It is safe to run at any time and as often as it likes — a pass over an
   * unchanged order writes nothing — so it retries freely.
   *
   * `expireInSeconds` is kept in step with RECONCILE_LEASE_MS in the order
   * repository: the per-order lock may only be taken over once pg-boss has
   * abandoned the job holding it. Ten minutes is generous because one pass can
   * make several MetaKocka calls and MetaKocka is slow (§3).
   */
  [QUEUES.reconcileOrder]: {
    deadLetter: DEAD_LETTER,
    retryLimit: 4,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 600,
  },
  // Pure and fast: it reads stock and rules and decides. Worth retrying, since
  // a failure here is almost always the database being briefly unavailable.
  [QUEUES.allocateOrder]: {
    deadLetter: DEAD_LETTER,
    retryLimit: 5,
    retryDelay: 15,
    retryBackoff: true,
    expireInSeconds: 300,
  },
  // Writes into the ERP. Retries are safe only because the count_code row is
  // claimed before the call goes out (section 8.4): MetaKocka would otherwise
  // happily create a second document.
  [QUEUES.writeMetakockaOrder]: {
    deadLetter: DEAD_LETTER,
    retryLimit: 4,
    retryDelay: 60,
    retryBackoff: true,
    // Kept in step with CLAIM_LEASE_MS in the order repository: a claim may be
    // taken over only once pg-boss has abandoned the job holding it.
    expireInSeconds: 300,
  },
  /*
   * §8.3 — moving and splitting Shopify fulfilment orders.
   *
   * **This queue has no consumer yet.** `allocate-order` sends to it and
   * nothing works it, so the jobs sit in `created` for ever. That is a feature
   * gap, recorded in docs/project-status.md T-08 rather than quietly filled in:
   * `fulfillmentOrderMove` and `fulfillmentOrderSplit` change what a merchant's
   * staff see in the Shopify admin, and that is not a decision to make
   * unattended.
   *
   * The explicit retention is what keeps the gap from also being a leak: an
   * unconsumed job is archived after a week instead of accumulating one row
   * per allocated order for ever. Remove it when the handler lands.
   */
  [QUEUES.writeShopifyFulfilment]: {
    deadLetter: DEAD_LETTER,
    retryLimit: 4,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 600,
    retentionSeconds: 60 * 60 * 24 * 7,
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
  // Several product_list pages, and MetaKocka is slow (3), so it gets a longer
  // window than the registers it sits beside. Nothing depends on it finishing:
  // a stale list only means the settings screen offers fewer suggestions.
  [QUEUES.reloadPricelists]: {
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
