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
  [QUEUES.customersDataRequest]: COMPLIANCE_POLICY,
  [QUEUES.customersRedact]: COMPLIANCE_POLICY,
  [QUEUES.shopRedact]: COMPLIANCE_POLICY,
};

export const ALL_QUEUES: QueueName[] = Object.values(QUEUES);
