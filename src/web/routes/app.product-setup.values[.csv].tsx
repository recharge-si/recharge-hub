import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "~/adapters/shopify/shopify.server";
import { exportValues, parsePreset } from "~/web/lib/bulk-values.server";
import { principalFromSession } from "~/web/lib/principal.server";

/**
 * The export of attribute values (docs/attributes.md § Bulk values): the
 * products of the chosen types as one spreadsheet, a row per variant.
 * `?types=a,b` names the types (ids), `?attributes=rig|all` the columns.
 * Fetched from the page by `DownloadButton`, so the session token travels.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const url = new URL(request.url);
  const typeIds = url.searchParams
    .getAll("types")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value !== "");

  const outcome = await exportValues(admin, principal, {
    typeIds,
    preset: parsePreset(url.searchParams.get("attributes")),
  });
  if (!outcome.ok)
    return new Response(outcome.message, {
      status: outcome.status,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  return new Response(outcome.body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${outcome.fileName}"`,
      "Cache-Control": "no-store",
    },
  });
};
