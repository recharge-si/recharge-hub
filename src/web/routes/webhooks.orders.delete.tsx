import type { ActionFunctionArgs } from "react-router";

import { QUEUES } from "~/adapters/queue/queues";
import { receiveWebhook } from "~/web/lib/webhook.server";

/**
 * orders/delete. The order disappears from this app; the MetaKocka document
 * stays exactly where it is (CLAUDE.md section 8.8 — never auto-delete a
 * document, it may already be invoiced).
 */
export const action = ({ request }: ActionFunctionArgs) =>
  receiveWebhook(request, QUEUES.ordersEvent);
