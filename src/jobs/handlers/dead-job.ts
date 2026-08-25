import type { JobWithMetadata } from "pg-boss";
import { z } from "zod";

import { prisma } from "~/adapters/db/client.server";
import { raiseException } from "~/adapters/db/repositories/exception.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { captureException } from "~/adapters/observability/sentry.server";
import { serviceToken } from "~/domain/types";

/**
 * The dead-letter consumer (Â§11).
 *
 * A retryable failure needs no human because the queue is dealing with it.
 * Once the last retry has failed, the queue has stopped dealing with it — and
 * before this handler existed, that was the end of the story: the job moved to
 * pg-boss's failed state and nothing the merchant can see ever mentioned it.
 * An order could sit allocated-but-unsent for good, with a green dashboard.
 *
 * Every dead-lettered job lands here with its original payload, the queue it
 * came from (`sourceName`) and the failure pg-boss recorded (`output`). What
 * this handler does is deliberately small: it says so, where the merchant
 * looks. It never re-runs the work — the work has just failed its whole retry
 * budget, and the exception's retry button re-drives it through the same
 * mapping every other retry uses (adapters/queue/redrive.server.ts).
 */

/**
 * The one field every payload in this app carries, plus the order id where the
 * work was about an order. Loose on purpose: a payload this cannot parse is
 * still a dead job worth reporting, just one that cannot be pinned to a shop.
 */
const deadJobDataSchema = z
  .object({
    shopDomain: z.string().min(1).optional(),
    orderId: z.string().min(1).optional(),
  })
  .passthrough();

function failureSummary(output: unknown): string | null {
  if (output === null || typeof output !== "object") return null;
  const message = (output as { message?: unknown }).message;
  if (typeof message !== "string" || message.length === 0) return null;
  // The failure detail can embed anything the throwing code put in the error.
  // A summary for the exception row does not need more than a line.
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

export async function handleDeadJob(
  job: JobWithMetadata<unknown>,
): Promise<void> {
  const log = getLogger();
  const queue = job.sourceName ?? "unknown queue";
  const parsed = deadJobDataSchema.safeParse(job.data);
  const shopDomain = parsed.success ? parsed.data.shopDomain : undefined;
  const orderId = parsed.success ? parsed.data.orderId : undefined;

  log.error(
    { queue, jobId: job.id, shop: shopDomain },
    "Job exhausted its retries and was dead-lettered",
  );

  if (!shopDomain) {
    // Nothing to attribute it to, so the merchant cannot be told. Sentry is
    // the only audience left, and this is exactly what it is for.
    captureException(
      new Error(`Dead-lettered job from ${queue} carries no shopDomain`),
      { queue, jobId: job.id },
    );
    return;
  }

  const principal = serviceToken(shopDomain, "dead-job");
  const summary = failureSummary(job.output);

  /*
   * raiseException dedupes per (order, kind), which covers every order-scoped
   * death. A queue-level job has no order, so the same queue dying nightly
   * would otherwise stack a fresh row each time — one condition, one row.
   */
  if (!orderId) {
    const open = await prisma.exception.findFirst({
      where: {
        shop: { domain: shopDomain },
        orderId: null,
        kind: "job_failed",
        status: "open",
        detail: { path: ["queue"], equals: queue },
      },
      select: { id: true },
    });
    if (open) {
      await prisma.exception.update({
        where: { id: open.id },
        data: {
          detail: { queue, jobId: job.id, ...(summary ? { failure: summary } : {}) },
        },
      });
      return;
    }
  }

  await raiseException(principal, {
    orderId: orderId ?? null,
    kind: "job_failed",
    message: orderId
      ? `Background work for this order stopped after repeated failures (${queue}). Nothing further will happen to it on its own. Use Retry once the cause named below is dealt with.`
      : `Background work stopped after repeated failures (${queue}). It will not run again on its own. ${summary ? "The recorded failure is below." : "Check the MetaKocka connection and the app's health, then run it again from its page."}`,
    detail: {
      queue,
      jobId: job.id,
      ...(summary ? { failure: summary } : {}),
    },
  });
}
