import type { ActionFunctionArgs } from "react-router";

import { QUEUES } from "~/adapters/queue/queues";
import { receiveWebhook } from "~/web/lib/webhook.server";

/**
 * orders/edited.
 *
 * Unlike the other order topics, the payload here is not an order: it is an
 * `order_edit` describing the additions and removals. So this one cannot be
 * compared directly, and `orders-event` turns it into a re-read of the order
 * itself, which then goes through the same comparison as everything else
 * (§8.8).
 */
export const action = ({ request }: ActionFunctionArgs) =>
  receiveWebhook(request, QUEUES.ordersEvent);
