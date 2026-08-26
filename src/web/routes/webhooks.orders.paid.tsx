import type { ActionFunctionArgs } from "react-router";

import { QUEUES } from "~/adapters/queue/queues";
import { receiveWebhook } from "~/web/lib/webhook.server";

/**
 * orders/paid.
 *
 * Redundant with `orders/updated`, and subscribed to precisely because it is.
 * This is the one event that moves money into the merchant's books, so it gets
 * two independent chances to arrive — and a third, the reconciler, when neither
 * does. The duplicate costs a comparison: whichever lands second finds the
 * payment already recorded and stops (§8.7).
 */
export const action = ({ request }: ActionFunctionArgs) =>
  receiveWebhook(request, QUEUES.syncOrderState);
