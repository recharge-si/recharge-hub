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
 *
 * **`id_token` is carried on a document redirect and dropped on an action's.**
 * The session token is minted per request, lives about a minute, and is spent
 * the moment `authenticate.admin` reads it. Carrying it onto the *first*
 * document request is what lets guided setup authenticate without a bounce, and
 * that is a GET. An action is different: React Router answers a form submission
 * by throwing the redirect and then re-fetching the next step's loader from the
 * client. Baking the just-spent token into that URL means the follow-up request
 * carries a stale `id_token` instead of a fresh one, and the embedded-auth
 * handshake reads the stale one: the loader is turned away with an empty-bodied
 * 401 (or bounced to a page whose HTML a data fetch cannot decode), which is the
 * literal "Handling response" the library's error boundary shows for an
 * `ErrorResponse` with no body. So on anything but a GET the token is removed
 * and App Bridge supplies a fresh one for the next request. This is why saving a
 * setup step wrote its data and then stalled instead of moving on.
 *
 * `_routes`, `_data` and `index` are React Router's own single-fetch markers.
 * They belong to the request that carried them, never to a redirect target, so
 * they are dropped alongside the token.
 */
const REQUEST_SCOPED_PARAMS = ["id_token", "_routes", "_data", "index"];

export function redirectWithin(
  request: Request,
  path: string,
  params: Record<string, string | undefined> = {},
): Response {
  const next = new URLSearchParams(new URL(request.url).search);

  if (request.method !== "GET") {
    for (const key of REQUEST_SCOPED_PARAMS) next.delete(key);
  }

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") next.delete(key);
    else next.set(key, value);
  }

  const search = next.toString();
  return redirect(search ? `${path}?${search}` : path);
}
