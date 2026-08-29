import { redirect } from "react-router";

/**
 * Redirecting inside the embedded admin, without dropping what embeds it.
 *
 * Shopify opens the app as a document request carrying `host`, `embedded`,
 * `shop` and `id_token`. `host` is what App Bridge initialises from and
 * `id_token` is what `authenticate.admin` reads, so a redirect that builds a
 * fresh URL loses both: the browser follows it to a page with no `host`, App
 * Bridge never comes up, the session token never arrives, and what the merchant
 * sees is a blank frame rather than an error.
 *
 * It hides well. In-app navigation is a client-side fetch, and the running App
 * Bridge does not care what the redirect said, so every path a person clicks
 * through looks right. Only a redirect on the *first* document request shows
 * it — which is why it surfaced on a shop with nothing configured, where
 * opening the app goes straight to guided setup.
 *
 * So: carry the query string, and say what changes. A value of `undefined`
 * removes a parameter, which is how a stale `note` or `step` is dropped rather
 * than following the merchant to the next page.
 *
 * The one redirect that must not use this is `/auth/login`, which is the
 * un-embedded document and has no admin frame to preserve.
 */
export function redirectWithin(
  request: Request,
  path: string,
  params: Record<string, string | undefined> = {},
): Response {
  const next = new URLSearchParams(new URL(request.url).search);

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") next.delete(key);
    else next.set(key, value);
  }

  const search = next.toString();
  return redirect(search ? `${path}?${search}` : path);
}
