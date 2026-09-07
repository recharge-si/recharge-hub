import { type LoaderFunctionArgs } from "react-router";

import { redirectWithin } from "~/web/lib/redirects";

/**
 * Locations moved out of Settings and became a top-level area (the product UX
 * brief, section 13).
 *
 * Kept as a redirect rather than deleted: merchants bookmark settings pages,
 * and a bookmark that 404s is a support ticket. The query string travels so a
 * deep link keeps whatever it was pointing at.
 */
export const loader = ({ request }: LoaderFunctionArgs) => {
  // Through the shared helper, so a moved route keeps `host` and the rest
  // of what embeds it the same way every other redirect here does.
  throw redirectWithin(request, "/app/locations");
};
