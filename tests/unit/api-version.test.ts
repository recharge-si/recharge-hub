import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { API_VERSION } from "~/adapters/shopify/shopify.server";

/**
 * One Admin API version, in two files that cannot import each other.
 *
 * `shopify.app.toml` tells Shopify which version to send webhooks in;
 * `API_VERSION` is what the Admin client speaks and what every recorded
 * fixture was captured against (§7 was verified on 2026-07). When the two
 * drift the app reads payloads in a shape it did not ask for, and nothing
 * fails until a field moves.
 *
 * The toml is not TypeScript and the CLI reads it directly, so a shared
 * constant is not available. This is the next best thing: the drift becomes a
 * failing test rather than a field that quietly stops arriving.
 */
describe("the Admin API version", () => {
  it("is the same in shopify.app.toml as in the client", () => {
    const toml = readFileSync(
      resolve(process.cwd(), "shopify.app.toml"),
      "utf8",
    );

    const match = /^\s*api_version\s*=\s*"([^"]+)"\s*$/m.exec(toml);
    expect(match?.[1]).toBe(API_VERSION);
  });
});
