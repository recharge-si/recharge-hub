import type { Job } from "pg-boss";
import { z } from "zod";

import {
  postSlackMessage,
  type FetchLike,
} from "~/adapters/alerts/slack.server";
import { getEnv } from "~/adapters/config/env.server";
import {
  claimExceptionAlert,
  releaseExceptionAlert,
} from "~/adapters/db/repositories/exception.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { alertLink, formatAlert, isAlertKind } from "~/domain/alerts";
import { serviceToken } from "~/domain/types";

/**
 * Announces one newly opened severe exception to Slack (docs/architecture.md
 * § Operator alerts).
 *
 * Queued by `raiseException` when a row of an alert kind opens and
 * `ALERT_SLACK_WEBHOOK_URL` is set; with it unset this does nothing, even for
 * a job queued before it was removed. The message carries the kind, the shop
 * and the order number and a link — never the exception's own text, which
 * can quote what MetaKocka said about a customer.
 */

export const notifyExceptionJobSchema = z.object({
  shopDomain: z.string().min(1),
  exceptionId: z.string().min(1),
});

/** One message per condition per day, however often it reopens. */
export const ALERT_REPEAT_WINDOW_MS = 24 * 60 * 60_000;
/** At most this many messages per shop per hour; the rest wait on the page. */
export const ALERTS_PER_SHOP_HOURLY = 20;

export async function handleNotifyException(
  job: Job<unknown>,
  options: { fetchImpl?: FetchLike; now?: Date } = {},
): Promise<void> {
  const { shopDomain, exceptionId } = notifyExceptionJobSchema.parse(job.data);
  const env = getEnv();
  const webhookUrl = env.ALERT_SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;

  const principal = serviceToken(shopDomain, "notify-exception");
  const log = getLogger();

  const claim = await claimExceptionAlert(principal, exceptionId, {
    now: options.now ?? new Date(),
    repeatWindowMs: ALERT_REPEAT_WINDOW_MS,
    perShopHourly: ALERTS_PER_SHOP_HOURLY,
  });
  if (!claim.claimed) {
    log.info(
      { shop: shopDomain, exceptionId, why: claim.why },
      "Exception alert not sent",
    );
    return;
  }
  const { alert } = claim;
  if (!isAlertKind(alert.kind)) return;

  const text = formatAlert({
    kind: alert.kind,
    shopDomain,
    orderNumber: alert.orderNumber,
    queue: alert.kind === "job_failed" ? alert.queue : null,
    link: alertLink({
      shopDomain,
      apiKey: env.SHOPIFY_API_KEY,
      orderId: alert.orderId,
    }),
  });

  try {
    await postSlackMessage(webhookUrl, text, options.fetchImpl);
  } catch (error) {
    // Given back so the queue's retry can send it; thrown so it does.
    await releaseExceptionAlert(principal, exceptionId);
    throw error;
  }

  log.info(
    { shop: shopDomain, exceptionId, kind: alert.kind },
    "Exception alert sent",
  );
}
