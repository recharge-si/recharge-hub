import type { ActionFunctionArgs } from "react-router";

import { QUEUES } from "~/adapters/queue/queues";
import { receiveWebhook } from "~/web/lib/webhook.server";

/**
 * orders/updated. The broadest signal Shopify offers about an order.
 *
 * It fires for a payment being captured, an address being corrected, a line
 * being edited, a tag being added — and this app cannot tell which from the
 * topic. `sync-order-state` compares the payload with what is stored and acts
 * only on what actually moved, so the noisy ones cost one comparison and the
 * one that matters is never missed.
 */
export const action = ({ request }: ActionFunctionArgs) =>
  receiveWebhook(request, QUEUES.syncOrderState);
