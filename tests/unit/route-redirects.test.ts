import { describe, expect, it } from "vitest";
import { RouterContextProvider, type LoaderFunctionArgs } from "react-router";

import { loader as salesOrders } from "~/web/routes/app.settings.sales-orders";
import { loader as payments } from "~/web/routes/app.settings.payments";
import { loader as supplySources } from "~/web/routes/app.settings.supply-sources._index";

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
