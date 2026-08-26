import { redirect, type LoaderFunctionArgs } from "react-router";

/**
 * Locations moved out of Settings and became a top-level area (the product UX
 * brief, section 13).
 *
 * Kept as a redirect rather than deleted: merchants bookmark settings pages,
 * and a bookmark that 404s is a support ticket. The query string travels so a
 * deep link keeps whatever it was pointing at.
 */
export const loader = ({ request }: LoaderFunctionArgs) => {
  const search = new URL(request.url).search;
  throw redirect(`/app/locations${search}`);
};
