import { RouterContextProvider, type LoaderFunctionArgs } from "react-router";
import { describe, expect, it } from "vitest";

import { appEntryFor, isEmbeddedRequest } from "~/web/lib/app-entry";
import { APP_HOME, APP_NAV } from "~/web/lib/navigation";
import { loader as rootLoader } from "~/web/routes/_index";
import { loader as loginLoader } from "~/web/routes/auth.login/route";

/**
 * The app's root means Home for an installed merchant, never the login form.
 *
 * The bug this pins: clicking the app's name in the admin nav navigated to `/`
 * client-side, with no `shop` parameter, and the root decided that meant "not
 * embedded" and sent a signed-in merchant to a form asking for their shop
 * domain. Every request the admin can produce for the root is enumerated here
 * and must land in the authenticated app.
 */

const ORIGIN = "https://example.test";

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, { headers });
}

/** The framework argument object, built rather than asserted. */
function args(request: Request, pattern: string): LoaderFunctionArgs {
  return {
    request,
    url: new URL(request.url),
    pattern,
    params: {},
    context: new RouterContextProvider(),
  };
}

async function redirectOf(
  run: () => Promise<unknown> | unknown,
): Promise<{ status: number; location: string | null } | null> {
  try {
    await run();
  } catch (thrown) {
    if (thrown instanceof Response) {
      return {
        status: thrown.status,
        location: thrown.headers.get("location"),
      };
    }
    throw thrown;
  }
  return null;
}

describe("appEntryFor", () => {
  it("sends Shopify's first document load, with all its parameters, to /app", () => {
    const entry = appEntryFor(
      get("/?shop=demo.myshopify.com&host=abc&embedded=1&id_token=tok"),
    );
    expect(entry).toEqual({
      kind: "embedded",
      to: "/app?shop=demo.myshopify.com&host=abc&embedded=1&id_token=tok",
    });
  });

  it("treats the app-name click — a data fetch with only the session token header — as embedded", () => {
    const entry = appEntryFor(get("/", { authorization: "Bearer session" }));
    expect(entry).toEqual({ kind: "embedded", to: "/app" });
  });

  it("treats host, embedded and id_token each as proof of the admin frame", () => {
    for (const search of ["?host=abc", "?embedded=1", "?id_token=tok"]) {
      expect(appEntryFor(get(`/${search}`)).kind).toBe("embedded");
    }
  });

  it("still accepts a bare shop parameter at the root", () => {
    expect(appEntryFor(get("/?shop=demo.myshopify.com"))).toEqual({
      kind: "embedded",
      to: "/app?shop=demo.myshopify.com",
    });
  });

  it("sends a request carrying nothing at all to the login form", () => {
    expect(appEntryFor(get("/"))).toEqual({ kind: "login", to: "/auth/login" });
  });

  it("does not count a bare shop parameter as an admin marker", () => {
    expect(isEmbeddedRequest(get("/?shop=demo.myshopify.com"))).toBe(false);
  });
});

describe("the root route", () => {
  it("redirects an embedded request to /app with its query string intact", async () => {
    const result = await redirectOf(() =>
      rootLoader(
        args(get("/?shop=demo.myshopify.com&host=abc&embedded=1"), "/"),
      ),
    );
    expect(result).toEqual({
      status: 302,
      location: "/app?shop=demo.myshopify.com&host=abc&embedded=1",
    });
  });

  it("redirects an App Bridge data fetch to /app", async () => {
    const result = await redirectOf(() =>
      rootLoader(args(get("/", { authorization: "Bearer session" }), "/")),
    );
    expect(result).toEqual({ status: 302, location: "/app" });
  });

  it("redirects an outside request to the login form", async () => {
    const result = await redirectOf(() => rootLoader(args(get("/"), "/")));
    expect(result).toEqual({ status: 302, location: "/auth/login" });
  });
});

describe("the login route", () => {
  it("never renders the form for a request from inside the admin", async () => {
    const result = await redirectOf(() =>
      loginLoader(
        args(
          get("/auth/login?host=abc&embedded=1&shop=demo.myshopify.com"),
          "/auth/login",
        ),
      ),
    );
    expect(result).toEqual({
      status: 302,
      location: "/app?host=abc&embedded=1&shop=demo.myshopify.com",
    });
  });

  it("never renders the form for an App Bridge data fetch", async () => {
    const result = await redirectOf(() =>
      loginLoader(
        args(
          get("/auth/login", { authorization: "Bearer session" }),
          "/auth/login",
        ),
      ),
    );
    expect(result).toEqual({ status: 302, location: "/app" });
  });

  it("renders the form for a plain outside request", async () => {
    const data = await loginLoader(args(get("/auth/login"), "/auth/login"));
    expect(data).toEqual({ errors: {} });
  });

  it("does not loop: a shop named on the login page goes to Shopify, not back to /app", async () => {
    const result = await redirectOf(() =>
      loginLoader(
        args(get("/auth/login?shop=demo.myshopify.com"), "/auth/login"),
      ),
    );
    expect(result?.status).toBe(302);
    expect(result?.location).not.toMatch(/^\/app/);
    expect(result?.location).not.toBe("/auth/login");
  });
});

describe("the primary navigation", () => {
  it("names /app as the home route, hidden from the menu", () => {
    const home = APP_NAV.filter((item) => item.rel === "home");
    expect(home).toHaveLength(1);
    expect(home[0]?.href).toBe(APP_HOME);
  });

  it("keeps every entry inside the authenticated embedded app", () => {
    for (const item of APP_NAV) {
      expect(item.href.startsWith("/app")).toBe(true);
      expect(item.href).not.toContain("/auth");
    }
  });

  it("has no visible entry that only links to the home page", () => {
    const visible = APP_NAV.filter((item) => item.rel !== "home");
    expect(visible.some((item) => item.href === APP_HOME)).toBe(false);
  });
});
