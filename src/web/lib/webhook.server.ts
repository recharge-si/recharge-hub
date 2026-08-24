import { enqueue } from "~/adapters/queue/boss.server";
import type { QueueName } from "~/adapters/queue/queues";
import { getLogger } from "~/adapters/observability/logger.server";
import { captureException } from "~/adapters/observability/sentry.server";
import { authenticate } from "~/adapters/shopify/shopify.server";

/**
 * The shape every webhook route in this app takes (CLAUDE.md section 2.1.7):
 *
 *   1. `authenticate.webhook` verifies the HMAC against the raw body and throws a
 *      401 if it does not match. Nothing is parsed before that.
 *   2. The payload is handed to the queue.
 *   3. We respond 200 immediately. No MetaKocka call, no allocation, no sync
 *      happens inside the five-second budget.
 *
 * Shopify's `webhookId` is the idempotency key, so a redelivered webhook collapses
 * into the job that is already queued instead of running twice.
 */
export async function receiveWebhook(
  request: Request,
  queue: QueueName,
): Promise<Response> {
  const { shop, topic, webhookId, payload } =
    await authenticate.webhook(request);

  try {
    await enqueue(
      queue,
      { shopDomain: shop, webhookId, topic, payload },
      { singletonKey: webhookId },
    );
  } catch (error) {
    // Returning 500 asks Shopify to redeliver. Swallowing it would lose the event.
    getLogger().error(
      { err: error, shop, topic, webhookId },
      "Failed to enqueue webhook",
    );
    captureException(error, { shop, topic, webhookId });
    return new Response("Failed to enqueue", { status: 500 });
  }

  getLogger().info({ shop, topic, webhookId }, "Webhook queued");

  return new Response(null, { status: 200 });
}
