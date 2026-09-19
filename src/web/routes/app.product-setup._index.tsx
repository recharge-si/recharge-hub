import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "~/adapters/shopify/shopify.server";
import { PRODUCT_SETUP_ROUTES } from "~/web/lib/attributes";
import { redirectWithin } from "~/web/lib/redirects";

/** Product setup opens on product types; the other sections are one link away. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  throw redirectWithin(request, PRODUCT_SETUP_ROUTES.types);
};
