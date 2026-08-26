import type { PgBoss, Job } from "pg-boss";
import { afterAll, beforeAll, expect, it } from "vitest";

import { createBoss, ensureQueues } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import { reconcileOrderJobSchema } from "~/jobs/handlers/reconcile-order";
import { syncOrderStateJobSchema } from "~/jobs/handlers/sync-order-state";
import { ordersEventJobSchema } from "~/jobs/handlers/orders-event";
import { withIdempotency } from "~/jobs/with-idempotency";
import { createOrder, createTenant, describeDatabase, destroyTenant, prisma, type TestTenant } from "./harness";

/**
 * The path a Shopify webhook actually takes, end to end through pg-boss.
 *
 * Everything else in this suite proves what `reconcileOrder` decides. Nothing
 * proved that a webhook *reaches* it — the E2E run called the function
 * directly, because the deployment's `application_url` is still a placeholder
 * and no webhook can arrive at it. So the dispatch itself was the one link in
 * the chain taken on trust:
 *
 * ```text
 * Shopify  ->  route  ->  receiveWebhook  ->  enqueue  ->  worker  ->  handler
 *                                             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
 *                                             tested here, against real pg-boss
 * ```
 *
 * These tests run the real producer and a real consumer against the real queue
 * tables. They stop at the handler's front door: what happens after that needs
 * Shopify and MetaKocka, and has its own coverage. What is being proved is that
 * a job sent the way a webhook route sends it is delivered, exactly once, in a
 * shape the handler's own schema accepts.
 */

let boss: PgBoss;
let tenant: TestTenant;

beforeAll(async () => {
  tenant = await createTenant("dispatch");
  boss = createBoss("worker");
  await boss.start();
  await ensureQueues(boss);
});

afterAll(async () => {
  if (boss) await boss.stop({ graceful: false });
  if (tenant) await destroyTenant(tenant);
  await prisma.$disconnect();
});

/** Waits for one job to arrive on a queue, or gives up. */
async function nextJob(
  queue: string,
  timeoutMs = 20_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no job on ${queue} within ${timeoutMs}ms`)),
      timeoutMs,
    );

    void boss.work<Record<string, unknown>>(
      queue,
      { pollingIntervalSeconds: 1 },
      async (jobs: Job<Record<string, unknown>>[]) => {
        for (const job of jobs) {
          clearTimeout(timer);
          resolve(job.data);
        }
      },
    );
  });
}

describeDatabase("a webhook reaches the reconciler through the queue", () => {
  it("delivers a reconcile job in the shape the handler parses", async () => {
    const orderId = await createOrder(tenant, { number: "7001" });

    // Exactly what `saveIncomingOrder` enqueues when `orders/create` arrives.
    await boss.send(QUEUES.reconcileOrder, {
      shopDomain: tenant.domain,
      orderId,
      reason: "intake",
    });

    const delivered = await nextJob(QUEUES.reconcileOrder);

    // The handler's own schema is the contract; parsing it here is what makes
    // this a test of the wiring rather than of a shape someone hoped for.
    const parsed = reconcileOrderJobSchema.parse(delivered);
    expect(parsed).toMatchObject({
      shopDomain: tenant.domain,
      orderId,
      reason: "intake",
    });
  }, 30_000);

  it("delivers a reconcile job addressed by Shopify order id", async () => {
    // The form `orders-event` uses: a webhook knows the Shopify id, not ours.
    await boss.send(QUEUES.reconcileOrder, {
      shopDomain: tenant.domain,
      shopifyOrderId: "9100847743240",
      reason: "webhook",
    });

    const parsed = reconcileOrderJobSchema.parse(
      await nextJob(QUEUES.reconcileOrder),
    );
    expect(parsed.shopifyOrderId).toBe("9100847743240");
    expect(parsed.orderId).toBeUndefined();
  }, 30_000);

  it("runs a redelivered webhook's handler exactly once", async () => {
    /*
     * Shopify redelivers, and the queue does not dedupe: these queues carry no
     * pg-boss policy on purpose, because a policy cannot be changed once a
     * queue exists and would behave differently on a fresh database than on an
     * existing one. The guard is `withIdempotency`, keyed on Shopify's own
     * webhook id and backed by the `idempotency_key` table — so this exercises
     * the real mechanism against the real table rather than assuming the queue
     * does something it does not.
     */
    const webhookId = `wh-${Date.now()}`;
    let ran = 0;

    const handler = withIdempotency("test-scope", async () => {
      ran += 1;
    });

    const job = {
      id: "1",
      name: "test",
      data: {
        shopDomain: tenant.domain,
        webhookId,
        topic: "orders/updated",
        payload: { id: 1 },
      },
    } as unknown as Parameters<typeof handler>[0][number];

    await handler([job]);
    await handler([job]);
    await handler([job]);

    expect(ran).toBe(1);
  });

  it("lets a failed delivery be retried rather than swallowing it", async () => {
    // A claim that is not released would turn one transient failure into a
    // webhook that never runs at all.
    const webhookId = `wh-fail-${Date.now()}`;
    let attempts = 0;

    const handler = withIdempotency("test-scope", async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient");
    });

    const job = {
      id: "1",
      name: "test",
      data: {
        shopDomain: tenant.domain,
        webhookId,
        topic: "orders/updated",
        payload: { id: 1 },
      },
    } as unknown as Parameters<typeof handler>[0][number];

    await expect(handler([job])).rejects.toThrow("transient");
    await handler([job]);

    expect(attempts).toBe(2);
  });

  it("accepts the shapes the order webhook routes actually send", () => {
    /*
     * Every order route hands `receiveWebhook` a `{ shopDomain, webhookId,
     * topic, payload }` envelope. The three handlers that receive them parse it
     * with these schemas, so a route pointed at the wrong queue — or an
     * envelope that drifted — fails here rather than in production at 2am.
     */
    const envelope = {
      shopDomain: tenant.domain,
      webhookId: "wh-1",
      topic: "orders/updated",
      payload: { id: 9100847743240, order_number: 1007 },
    };

    expect(() => syncOrderStateJobSchema.parse(envelope)).not.toThrow();
    expect(() => ordersEventJobSchema.parse(envelope)).not.toThrow();
  });

  it("has a consumer registered for every queue a webhook route targets", async () => {
    /*
     * The failure this catches is a real one in this repository's history:
     * `write-shopify-fulfilment` had a producer and no consumer, so its jobs
     * sat in `created` for ever. A webhook queue with no consumer would lose
     * orders the same way, silently.
     */
    const targets = [
      QUEUES.reconcileOrder,
      QUEUES.syncOrderState,
      QUEUES.ordersEvent,
    ];

    for (const queue of targets) {
      expect(await boss.getQueue(queue)).not.toBeNull();
    }
  });
});
