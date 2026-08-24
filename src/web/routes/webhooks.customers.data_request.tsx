import type { ActionFunctionArgs } from "react-router";

import { QUEUES } from "~/adapters/queue/queues";
import { receiveWebhook } from "~/web/lib/webhook.server";

export const action = ({ request }: ActionFunctionArgs) =>
  receiveWebhook(request, QUEUES.customersDataRequest);
