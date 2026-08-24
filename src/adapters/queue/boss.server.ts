import type { Prisma } from "@prisma/client";
import { PgBoss, fromPrisma, type SendOptions } from "pg-boss";

import { getEnv } from "~/adapters/config/env.server";
import { getLogger } from "~/adapters/observability/logger.server";
import {
  ALL_QUEUES,
  QUEUE_DEFINITIONS,
  type QueueName,
} from "~/adapters/queue/queues";

/**
 * The producer side of pg-boss. The web process sends jobs; it does not consume
 * them, run the supervisor, or run schedules -- that is the worker's job
 * (jobs/worker.ts).
 *
 * Both roles connect to the same Postgres the application data lives in, which is
 * what makes the transactional enqueue below possible (CLAUDE.md section 8.1).
 */
let client: PgBoss | undefined;
let starting: Promise<PgBoss> | undefined;

export function createBoss(role: "producer" | "worker"): PgBoss {
  const env = getEnv();

  return new PgBoss({
    connectionString: env.DATABASE_URL,
    schema: "pgboss",
    // The compose stack runs `prisma migrate deploy` once before either process
    // starts, and pg-boss guards its own schema migration with an advisory lock,
    // so start order between the containers does not matter.
    migrate: true,
    createSchema: true,
    supervise: role === "worker",
    schedule: role === "worker",
    max: role === "worker" ? 10 : 4,
  });
}

/**
 * Declares every queue this app uses. Idempotent, safe from either process.
 *
 * `createQueue` does nothing when the queue already exists, so the retry and
 * retention settings are pushed again with `updateQueue`. Otherwise changing
 * them in code would never reach a database that already had the queue.
 *
 * `policy` is deliberately absent from the definitions: pg-boss throws
 * "queue policy cannot be changed after creation", which would take the worker
 * down on start against any existing database.
 */
export async function ensureQueues(boss: PgBoss): Promise<void> {
  for (const name of ALL_QUEUES) {
    const options = QUEUE_DEFINITIONS[name];
    await boss.createQueue(name, options);
    await boss.updateQueue(name, options);
  }
}

export async function getQueueClient(): Promise<PgBoss> {
  if (client) return client;

  starting ??= (async () => {
    const boss = createBoss("producer");

    boss.on("error", (error: Error) => {
      getLogger().error({ err: error }, "pg-boss producer error");
    });

    await boss.start();
    await ensureQueues(boss);

    client = boss;
    return boss;
  })();

  return starting;
}

export async function stopQueueClient(): Promise<void> {
  if (!client) return;

  await client.stop({ graceful: true });
  client = undefined;
  starting = undefined;
}

export interface EnqueueOptions {
  /**
   * Deduplication key. pg-boss keeps at most one pre-active job per
   * (queue, singletonKey), which is how a webhook Shopify delivers twice turns
   * into one unit of work.
   */
  singletonKey?: string;
  startAfterSeconds?: number;
  priority?: number;
}

function toSendOptions(options: EnqueueOptions | undefined): SendOptions {
  return {
    ...(options?.singletonKey ? { singletonKey: options.singletonKey } : {}),
    ...(options?.startAfterSeconds
      ? { startAfter: options.startAfterSeconds }
      : {}),
    ...(options?.priority ? { priority: options.priority } : {}),
  };
}

export async function enqueue(
  name: QueueName,
  data: object,
  options?: EnqueueOptions,
): Promise<string | null> {
  const boss = await getQueueClient();
  return boss.send(name, data, toSendOptions(options));
}

/**
 * Sends at most one job per key per window, and returns null when one was
 * already sent inside it.
 *
 * This is how the sync buttons avoid stacking work. Doing it with a queue
 * policy is not an option: a policy cannot be changed once the queue exists, so
 * it would behave differently on a fresh database than on an existing one.
 *
 * The caller is expected to tell the merchant when the result is null. Silently
 * swallowing a button press looks exactly like a broken button.
 */
export async function enqueueThrottled(
  name: QueueName,
  data: object,
  key: string,
  windowSeconds: number,
): Promise<string | null> {
  const boss = await getQueueClient();
  return boss.sendThrottled(name, data, null, windowSeconds, key);
}

/**
 * Runs the job insert on an existing Prisma transaction, so the row and the job
 * it triggers commit together (CLAUDE.md section 8.1). This is the reason the
 * queue lives in Postgres at all: never insert and enqueue in separate
 * transactions.
 */
export async function enqueueInTransaction(
  tx: Prisma.TransactionClient,
  name: QueueName,
  data: object,
  options?: EnqueueOptions,
): Promise<string | null> {
  const boss = await getQueueClient();

  return boss.send(name, data, {
    ...toSendOptions(options),
    db: fromPrisma(tx),
  });
}
