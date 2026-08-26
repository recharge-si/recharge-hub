import type { ActionFunctionArgs } from "react-router";

import { QUEUES } from "~/adapters/queue/queues";
import { receiveWebhook } from "~/web/lib/webhook.server";

/**
 * orders/cancelled. The payload is the order, with `cancelled_at` set.
 *
 * Handled by the same path as every other change to an order rather than by a
 * branch of its own: the cancellation usually arrives with a refund and a
 * changed financial status, and one comparison sees all three. Nothing is
 * deleted in MetaKocka — the document may already be invoiced (§8.8) — so this
 * ends with an exception and a human.
 */
export const action = ({ request }: ActionFunctionArgs) =>
  receiveWebhook(request, QUEUES.syncOrderState);
