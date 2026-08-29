import { type LoaderFunctionArgs } from "react-router";

import { redirectWithin } from "~/web/lib/redirects";

/**
 * Order sync stopped being a settings page of its own and became Orders ->
 * Settings (the product UX brief, section 13). Standing as a top-level concept
 * it asked merchants to know that "order sync" and "orders" were the same
 * subject; under Orders it does not.
 *
 * Redirected rather than removed, so an existing bookmark still lands on the
 * page that owns those settings now.
 */
export const loader = ({ request }: LoaderFunctionArgs) => {
  // Through the shared helper, so a moved route keeps `host` and the rest
  // of what embeds it the same way every other redirect here does.
  throw redirectWithin(request, "/app/orders/settings");
};
