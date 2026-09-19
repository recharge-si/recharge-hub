import type { ActionFunctionArgs } from "react-router";

import { QUEUES } from "~/adapters/queue/queues";
import { receiveWebhook } from "~/web/lib/webhook.server";

/**
 * products/update. Fires for every product change — including the price
 * writes this app makes for a sale campaign, which is why the handler
 * compares what Shopify holds with what the campaign wrote before it calls
 * anything a change (docs/sale-campaigns.md § Loop prevention).
 */
export const action = ({ request }: ActionFunctionArgs) =>
  receiveWebhook(request, QUEUES.saleProductEvent);
