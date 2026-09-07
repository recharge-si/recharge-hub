import { describe, expect, it } from "vitest";
import { RouterContextProvider, type LoaderFunctionArgs } from "react-router";

import { loader as salesOrders } from "~/web/routes/app.settings.sales-orders";
import { loader as payments } from "~/web/routes/app.settings.payments";
import { loader as supplySources } from "~/web/routes/app.settings.supply-sources._index";
import { redirectWithin } from "~/web/lib/redirects";

/**
 * The information architecture changed (the product UX brief, section 13) and
 * the old addresses still have to work.
 *
 * Merchants bookmark settings pages, exception guidance links to them, and
 * "Order sync" was in the primary navigation for long enough to be in somebody's
 * history. A moved page that 404s is a support ticket, so each old route is a
 * redirect and each one keeps the query string it was given.
 */

/**
 * Each loader reads the request and nothing else, so the rest of the
 * framework argument object is supplied as the empty values React Router would
 * give a route with no dynamic segments. No cast: the shape is built, not
 * asserted.
 */
function argsFor(url: string, pattern: string): LoaderFunctionArgs {
  return {
    request: new Request(url),
    url: new URL(url),
    pattern,
    params: {},
    context: new RouterContextProvider(),
  };
}

function run(
  loader: (args: LoaderFunctionArgs) => unknown,
  url: string,
  pattern: string,
): Response {
  try {
    loader(argsFor(url, pattern));
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
  throw new Error("expected the loader to redirect");
}

describe("old settings routes", () => {
  it("sends Order sync to Orders, Settings", () => {
    const response = run(
      salesOrders,
      "https://example.test/app/settings/sales-orders",
      "/app/settings/sales-orders",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/app/orders/settings");
  });

  it("sends Payment types under Orders, Settings", () => {
    const response = run(
      payments,
      "https://example.test/app/settings/payments",
      "/app/settings/payments",
    );

    expect(response.headers.get("location")).toBe(
      "/app/orders/settings/payments",
    );
  });

  it("sends Supply sources to Locations", () => {
    const response = run(
      supplySources,
      "https://example.test/app/settings/supply-sources",
      "/app/settings/supply-sources",
    );

    expect(response.headers.get("location")).toBe("/app/locations");
  });

  it("carries the query string, so a deep link still points somewhere", () => {
    const response = run(
      supplySources,
      "https://example.test/app/settings/supply-sources?shop=demo.myshopify.com&host=abc",
      "/app/settings/supply-sources",
    );

    expect(response.headers.get("location")).toBe(
      "/app/locations?shop=demo.myshopify.com&host=abc",
    );
  });
});

/**
 * The parameters that make the admin frame work.
 *
 * Shopify opens the app as a document request carrying `host`, `embedded`,
 * `shop` and `id_token`. A redirect that builds a fresh URL loses them, App
 * Bridge never initialises, and the merchant gets a blank frame rather than
 * an error — which is what happened to a shop with nothing configured, where
 * opening the app redirects straight to guided setup on the first document
 * request. Every in-app redirect goes through this.
 *
 * The exception is `id_token` on a redirect thrown from an *action*: the token
 * is single-use and already spent, and React Router re-fetches the next loader
 * from the client, so carrying it makes that fetch present a stale token and be
 * turned away — the "Handling response" that stalled guided setup after a step
 * was saved.
 */
describe("redirectWithin", () => {
  const EMBEDDED =
    "https://example.test/app?embedded=1&shop=demo.myshopify.com&host=abc&id_token=xyz";

  it("carries what embeds the page on a document request", () => {
    // A GET is the first document request; `id_token` is what lets guided setup
    // authenticate without a bounce, so it rides along with `host` and `shop`.
    const response = redirectWithin(new Request(EMBEDDED), "/app/setup");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/app/setup?embedded=1&shop=demo.myshopify.com&host=abc&id_token=xyz",
    );
  });

  it("drops the spent session token when an action redirects", () => {
    // The bug: after saving a setup step the app threw a redirect carrying the
    // just-spent `id_token`, the client re-fetched the next step's loader with
    // that stale token, and the embedded-auth handshake answered with the empty
    // response the library renders as "Handling response". The durable
    // embedding parameters still have to survive.
    const response = redirectWithin(
      new Request(EMBEDDED, { method: "POST" }),
      "/app/setup",
      { step: "orders" },
    );

    const location = new URL(
      response.headers.get("location")!,
      "https://example.test",
    );
    expect(location.searchParams.has("id_token")).toBe(false);
    expect(location.searchParams.get("host")).toBe("abc");
    expect(location.searchParams.get("shop")).toBe("demo.myshopify.com");
    expect(location.searchParams.get("embedded")).toBe("1");
    expect(location.searchParams.get("step")).toBe("orders");
  });

  it("drops React Router's single-fetch markers when an action redirects", () => {
    // `_routes`, `_data` and `index` belong to the request that carried them,
    // never to a redirect target the client will navigate to next.
    const response = redirectWithin(
      new Request(
        "https://example.test/app/setup.data?host=abc&_routes=routes%2Fapp.setup&_data=x&index=&step=stock",
        { method: "POST" },
      ),
      "/app/setup",
      { step: "orders" },
    );

    const location = new URL(
      response.headers.get("location")!,
      "https://example.test",
    );
    expect(location.searchParams.has("_routes")).toBe(false);
    expect(location.searchParams.has("_data")).toBe(false);
    expect(location.searchParams.has("index")).toBe(false);
    expect(location.searchParams.get("host")).toBe("abc");
    expect(location.searchParams.get("step")).toBe("orders");
  });

  it("sets what the caller names, keeping the rest", () => {
    const response = redirectWithin(
      new Request("https://example.test/app/setup?host=abc&step=welcome"),
      "/app/setup",
      { step: "connect" },
    );

    expect(response.headers.get("location")).toBe(
      "/app/setup?host=abc&step=connect",
    );
  });

  it("removes what the caller passes as undefined", () => {
    // Otherwise the note from one step follows the merchant through the whole
    // wizard, and the same banner is shown on every page after it.
    const response = redirectWithin(
      new Request("https://example.test/app/setup?host=abc&note=old&step=orders"),
      "/app",
      { note: undefined, step: undefined },
    );

    expect(response.headers.get("location")).toBe("/app?host=abc");
  });

  it("leaves a bare path bare", () => {
    const response = redirectWithin(
      new Request("https://example.test/app"),
      "/app/setup",
    );

    expect(response.headers.get("location")).toBe("/app/setup");
  });
});
