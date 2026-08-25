import type { ActionFunctionArgs } from "react-router";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { getCredential } from "~/adapters/db/repositories/metakocka-credential.server";
import {
  METAKOCKA_ACK,
  METAKOCKA_EVENT_HEADER,
  METAKOCKA_SIGNATURE_HEADER,
  verifyMetakockaSignature,
} from "~/adapters/metakocka/webhook";
import { enqueueThrottled } from "~/adapters/queue/boss.server";
import { QUEUES } from "~/adapters/queue/queues";
import { getLogger } from "~/adapters/observability/logger.server";
import { serviceToken } from "~/domain/types";

/**
 * MetaKocka's stock webhook — the only event it pushes (CLAUDE.md §3).
 *
 * This is the fastest path stock has. The scheduled sync runs every five
 * minutes and is the guarantee; this is what makes the common case immediate,
 * so a product selling out in the warehouse stops being sellable in the store
 * in seconds rather than minutes.
 *
 * **It is treated as a nudge, not as data.** The payload is not read for
 * quantities and nothing is written from it. Two reasons, and both are about
 * not building on sand:
 *
 *  - §3 records that MetaKocka retries a failed delivery **twice, sixty seconds
 *    apart, and then gives up**. That is not reliable delivery, so nothing may
 *    depend on any single message arriving.
 *  - Publishing stock is an accounting-grade decision (§7: `amount` to
 *    `on_hand`, never `available`, and only for locations this app owns). It
 *    goes through the sync job, which knows all of that, rather than through a
 *    webhook handler that would have to learn it again.
 *
 * So the handler verifies, acknowledges, and asks the sync to run. The sync
 * writes only what differs, so a burst of stock events collapses into one pass
 * that mostly finds nothing to do.
 *
 * The shop is in the URL because MetaKocka has no idea what a Shopify store is:
 * the merchant pastes a URL into their MetaKocka webhook settings, and that URL
 * is per-shop. The path is not a secret and is not treated as one — the
 * signature is what authenticates the request.
 */
export const action = async ({ request, params }: ActionFunctionArgs) => {
  const log = getLogger();
  const shopDomain = params.shop ?? "";

  // Read the raw body first and never parse it before the signature is checked
  // (§2.1.7). A re-serialised body is not the body that was signed.
  const rawBody = await request.text();
  const signature = request.headers.get(METAKOCKA_SIGNATURE_HEADER);
  const eventId = request.headers.get(METAKOCKA_EVENT_HEADER);

  const principal = serviceToken(shopDomain, "metakocka-stock-webhook");
  const credential = await getCredential(principal);

  if (!credential?.webhookClientSecret) {
    /*
     * No secret to check against, so nothing here can be trusted.
     *
     * 401 rather than 200: MetaKocka will retry twice and give up, which is the
     * correct outcome for a shop that has not finished setting the webhook up.
     * Answering "ok" would hide a broken configuration behind a green light.
     */
    log.warn(
      { shop: shopDomain },
      "MetaKocka stock webhook arrived with no client secret configured",
    );
    return new Response("Not configured", { status: 401 });
  }

  if (
    !verifyMetakockaSignature(
      rawBody,
      signature,
      credential.webhookClientSecret,
    )
  ) {
    // Never log the body or the secret (§10). The shop and the event id are
    // enough to find it in MetaKocka's own log.
    log.warn(
      { shop: shopDomain, eventId },
      "MetaKocka stock webhook failed signature verification",
    );
    return new Response("Bad signature", { status: 401 });
  }

  /*
   * Collapse a burst.
   *
   * A delivery arriving in MetaKocka moves dozens of products at once and each
   * one is its own event. Thirty seconds is long enough to fold them into a
   * single sync and short enough that nobody notices the delay.
   */
  try {
    await enqueueThrottled(
      QUEUES.syncInventory,
      { shopDomain },
      `inventory:${shopDomain}`,
      30,
    );

    await appendEvent(principal, {
      entityType: "inventory",
      event: "inventory.stock_event_received",
      detail: { eventId },
    });
  } catch (error) {
    /*
     * Even a failure is acknowledged.
     *
     * MetaKocka gives up after two retries, so there is nothing to be gained by
     * asking it to try again — and the five-minute sync will pick the change up
     * regardless. Failing loudly here would only lose the event *and* leave the
     * merchant with a red webhook in their MetaKocka settings.
     */
    log.error(
      { err: error, shop: shopDomain, eventId },
      "Could not queue the stock sync from a MetaKocka webhook",
    );
  }

  // §3: the response must be JSON containing check_respond_status_json_ok.
  // A bare 200 is read as a failure.
  return new Response(JSON.stringify(METAKOCKA_ACK), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

/** MetaKocka only ever POSTs here. A GET is somebody checking the URL by hand. */
export const loader = () =>
  new Response(JSON.stringify(METAKOCKA_ACK), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
