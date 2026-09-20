import type { ActionFunctionArgs } from "react-router";

import { QUEUES } from "~/adapters/queue/queues";
import { receiveWebhook } from "~/web/lib/webhook.server";

/**
 * products/create. A new product is translated into every language with
 * automatic translation on (docs/translations.md § Automatic translation).
 * Sale campaigns learn of it through the products/update that follows.
 */
export const action = ({ request }: ActionFunctionArgs) =>
  receiveWebhook(request, QUEUES.translationResourceEvent);
