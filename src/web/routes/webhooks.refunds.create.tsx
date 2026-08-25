import type { ActionFunctionArgs } from "react-router";

import { QUEUES } from "~/adapters/queue/queues";
import { receiveWebhook } from "~/web/lib/webhook.server";

/**
 * refunds/create. Not implemented in v1 (CLAUDE.md section 8.8), but received from day
 * one and turned into an exception, so nothing is lost silently.
 */
export const action = ({ request }: ActionFunctionArgs) =>
  receiveWebhook(request, QUEUES.ordersEvent);
