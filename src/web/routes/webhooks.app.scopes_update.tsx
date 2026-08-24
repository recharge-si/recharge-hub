import { z } from "zod";
import type { ActionFunctionArgs } from "react-router";

import { prisma } from "~/adapters/db/client.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { getLogger } from "~/adapters/observability/logger.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { serviceToken } from "~/domain/types";

const scopesUpdateSchema = z.object({
  current: z.array(z.string()).default([]),
});

/**
 * Scope changes are two bounded writes, so they run inline rather than through the
 * queue. Everything else about the contract is the same: HMAC first, respond fast.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, payload, webhookId } =
    await authenticate.webhook(request);

  const { current } = scopesUpdateSchema.parse(payload);

  if (session) {
    await prisma.session.update({
      where: { id: session.id },
      data: { scope: current.join(",") },
    });
  }

  await appendEvent(serviceToken(shop, "app-scopes-update"), {
    entityType: "shop",
    entityId: shop,
    event: "app.scopes_updated",
    detail: { webhookId, scopes: current },
  });

  getLogger().info({ shop, webhookId, scopes: current }, "Scopes updated");

  return new Response(null, { status: 200 });
};
