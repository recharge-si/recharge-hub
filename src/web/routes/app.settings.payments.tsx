import { type LoaderFunctionArgs } from "react-router";

import { redirectWithin } from "~/web/lib/redirects";

/**
 * Payment types moved under Orders -> Settings, beside the order behaviour they
 * belong to (the product UX brief, section 13). Redirected rather than removed:
 * this page is linked from exception guidance a merchant may have open.
 */
export const loader = ({ request }: LoaderFunctionArgs) => {
  // Through the shared helper, so a moved route keeps `host` and the rest
  // of what embeds it the same way every other redirect here does.
  throw redirectWithin(request, "/app/orders/settings/payments");
};
