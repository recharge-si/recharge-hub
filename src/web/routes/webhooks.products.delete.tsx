import type { ActionFunctionArgs } from "react-router";

import { QUEUES } from "~/adapters/queue/queues";
import { receiveWebhook } from "~/web/lib/webhook.server";

/**
 * products/delete. A deleted product cannot have its price put back; its
 * campaign rows are released and the catalogue snapshot forgets it.
 */
export const action = ({ request }: ActionFunctionArgs) =>
  receiveWebhook(request, QUEUES.saleProductEvent);
