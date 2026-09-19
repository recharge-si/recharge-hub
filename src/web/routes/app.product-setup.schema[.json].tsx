import type { LoaderFunctionArgs } from "react-router";

import { getAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { principalFromSession } from "~/web/lib/principal.server";

/**
 * The schema as a file (docs/attributes.md § Import and export): the whole
 * document, exactly as stored, so it can be kept, shared or imported again
 * here or in the standalone builder. Fetched from the page by
 * `DownloadButton`, which is what carries the session token.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const { schema } = await getAttributeSchema(principal);

  const date = new Date().toISOString().slice(0, 10);
  return new Response(`${JSON.stringify(schema, null, 2)}\n`, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="product-setup-${date}.json"`,
      "Cache-Control": "no-store",
    },
  });
};
