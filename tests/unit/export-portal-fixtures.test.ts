import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import { ExportPortalClient } from "~/adapters/export-portal/client.server";
import { ExportPortalError } from "~/adapters/export-portal/errors";
import { errorReplySchema, replies } from "~/domain/export-portal/contract";

/**
 * Recorded replies of the real portal routes, parsed with this app's
 * contract (tests/fixtures/export-portal/README.md). Both repos passing
 * means they agree. The mutated copies prove the parse can fail.
 */
const DIR = resolve(process.cwd(), "tests/fixtures/export-portal");
const read = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(DIR, `${name}.json`), "utf8"));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const SUCCESS: Array<[string, ZodType]> = [
  ["connection", replies.connection],
  ["source-types", replies.sourceTypes],
  ["sources", replies.sources],
  ["source", replies.source],
  ["runs", replies.runs],
  ["run-started", replies.run],
  ["run-detail", replies.runDetail],
  ["run-detail-failed", replies.runDetail],
  ["ai-categorize", replies.categorize],
  ["ai-extract-attributes", replies.extractAttributes],
];

describe("the copied fixtures", () => {
  it("match the sha256 lines in their README", () => {
    const readme = readFileSync(resolve(DIR, "README.md"), "utf8");
    const listed = new Map<string, string>();
    for (const m of readme.matchAll(/^([0-9a-f]{64})\s+(\S+\.json)$/gm)) {
      listed.set(m[2] as string, m[1] as string);
    }
    const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
    expect([...listed.keys()].sort()).toEqual(files.sort());
    for (const file of files) {
      const hash = createHash("sha256")
        .update(readFileSync(resolve(DIR, file)))
        .digest("hex");
      expect(hash, file).toBe(listed.get(file));
    }
  });
});

describe("the portal's replies parse", () => {
  it.each(SUCCESS)("%s", (name, schema) => {
    const result = schema.safeParse(read(name));
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it("sources covers every health value", () => {
    const { sources } = replies.sources.parse(read("sources"));
    expect(new Set(sources.map((s) => s.health))).toEqual(
      new Set(["ok", "needs_attention", "never_ran", "off"]),
    );
  });

  it("runs covers running, completed and failed, each naming its source", () => {
    const { runs } = replies.runs.parse(read("runs"));
    expect(runs.map((r) => r.status).sort()).toEqual([
      "completed",
      "failed",
      "running",
    ]);
    for (const run of runs) expect(run.sourceId.length).toBeGreaterThan(0);
  });

  it("the source carries a tokens field and no portalUrl (the portal omits a relative one)", () => {
    const { source } = replies.source.parse(read("source"));
    expect(source.fields.some((f) => (f.tokens?.length ?? 0) > 0)).toBe(true);
    expect(source.portalUrl).toBeUndefined();
  });

  it.each([401, 403, 404, 409, 422, 502, 503])(
    "error-%i parses and the client turns it into a typed failure",
    async (status) => {
      const body = read(`error-${status}`);
      expect(errorReplySchema.safeParse(body).success).toBe(true);
      const client = new ExportPortalClient(
        {
          baseUrl: "https://export.example.test",
          apiKey: "rhk_test_0123456789abcdef",
          shopDomain: "recharge.myshopify.com",
        },
        {
          fetchImpl: (async () =>
            new Response(JSON.stringify(body), {
              status,
              headers: { "content-type": "application/json" },
            })) as unknown as typeof fetch,
          timeoutMs: 200,
        },
      );
      const error = await client.listSources().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ExportPortalError);
      expect((error as ExportPortalError).httpStatus).toBe(status);
      expect((error as ExportPortalError).kind).not.toBe("unreadable");
    },
  );
});

describe("a changed copy fails (the test bites)", () => {
  const mutations: Array<[string, string, ZodType, (v: never) => void]> = [
    [
      "a source with an unknown health",
      "sources",
      replies.sources,
      (v: { sources: Array<{ health: string }> }) => {
        v.sources[0]!.health = "sleeping";
      },
    ],
    [
      "a run with an empty sourceId",
      "runs",
      replies.runs,
      (v: { runs: Array<{ sourceId: string }> }) => {
        v.runs[0]!.sourceId = "";
      },
    ],
    [
      "a run missing its status",
      "run-started",
      replies.run,
      (v: { run: Record<string, unknown> }) => {
        delete v.run.status;
      },
    ],
    [
      "a source with a relative portalUrl",
      "source",
      replies.source,
      (v: { source: Record<string, unknown> }) => {
        v.source.portalUrl = "/shopify";
      },
    ],
    [
      "a field of an unknown type",
      "source-types",
      replies.sourceTypes,
      (v: { types: Array<{ fields: Array<{ type: string }> }> }) => {
        v.types[0]!.fields[0]!.type = "colour";
      },
    ],
    [
      "a connection without a tenant name",
      "connection",
      replies.connection,
      (v: { tenant: Record<string, unknown> }) => {
        delete v.tenant.name;
      },
    ],
  ];

  it.each(mutations)("%s", (_label, name, schema, mutate) => {
    const copy = clone(read(name));
    mutate(copy as never);
    expect(schema.safeParse(copy).success).toBe(false);
  });
});
