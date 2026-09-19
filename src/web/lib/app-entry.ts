/**
 * Where a request for the app's root belongs: inside the embedded admin, or on
 * the one un-embedded document this app has, the shop-domain login form.
 *
 * The distinction used to be "is there a `shop` query parameter", and that was
 * only right for the first document Shopify loads. Two other requests reach the
 * root and carry no `shop` at all:
 *
 *  - **The app's own name in the admin nav.** App Bridge links it to the app's
 *    home route, `/` unless the nav says otherwise, and dispatches
 *    `shopify:navigate` for it. React Router answers with a client-side data
 *    fetch of `/` — no `shop`, no `host`, just the session token App Bridge
 *    puts in the `Authorization` header of every same-origin fetch. Deciding
 *    "not embedded" from the missing parameter sent an installed, signed-in
 *    merchant to a form asking which shop they are, which is the bug this file
 *    exists to close. The nav now names `/app` as the home route as well
 *    (`rel="home"`), so this path is the belt to that fix's braces.
 *  - **A bounced document request.** The library's session-token bounce page
 *    reloads the URL it was given with `host`, `embedded=1` and a fresh
 *    `id_token`; `shop` is normally there too, but it is not what proves the
 *    request came from the admin.
 *
 * So embedded means any of the admin's own markers: the App Bridge session
 * token header, or `host`, `embedded`, `id_token` or `shop` in the query. An
 * embedded request is sent on to `/app`, where `authenticate.admin` does the
 * real work — it can restore a session from the header, exchange a token from
 * the URL, or render App Bridge to fetch one, and it never renders a login form.
 * Only a request carrying none of those is a person arriving from outside the
 * admin, and that is the one case the login form is for.
 *
 * Pure so it can be tested with a `Request` and nothing else.
 */

export type AppEntry =
  { kind: "embedded"; to: string } | { kind: "login"; to: "/auth/login" };

/**
 * The admin's own markers. `shop` is deliberately not one of them: it is also
 * what the login form collects, so on its own it says "somebody named a shop",
 * not "this came from the admin frame".
 */
const ADMIN_MARKERS = ["host", "embedded", "id_token"] as const;

/** True when the request carries a marker of the embedded Shopify admin. */
export function isEmbeddedRequest(request: Request): boolean {
  if (request.headers.get("authorization")) return true;

  const url = new URL(request.url);
  return ADMIN_MARKERS.some((key) => url.searchParams.has(key));
}

/**
 * Where the root sends this request. A `shop` parameter counts here as well —
 * Shopify's first document load carries it, and a shop named at the root has
 * nowhere else to go but the authenticated app. The query string travels with
 * an embedded redirect for the reason `redirectWithin` gives: `host` and
 * `id_token` are what let the next document request authenticate at all.
 */
export function appEntryFor(request: Request): AppEntry {
  const embedded =
    isEmbeddedRequest(request) || new URL(request.url).searchParams.has("shop");
  if (!embedded) return { kind: "login", to: "/auth/login" };

  const search = new URL(request.url).search;
  return { kind: "embedded", to: search ? `/app${search}` : "/app" };
}
