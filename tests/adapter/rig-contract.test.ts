import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { RateLimiter } from "~/adapters/rig/rate-limit";
import {
  fail,
  goodModel,
  post,
  read,
  setup,
} from "../support/rig-api-harness";
import { FIXTURES, REFERENCE } from "../support/rig-fixtures";

/**
 * The JSON contract of the three proxy routes, as files the theme side builds
 * against (tests/fixtures/rig/api/). Each file is the real output of the
 * handler for the stated request; this test fails when the handler and the
 * file drift. Regenerate with `UPDATE_RIG_FIXTURES=1 npx vitest run
 * tests/adapter/rig-contract.test.ts` after a deliberate contract change.
 */

const DIR = join(FIXTURES, "api");
const FIXED_ID = "rb_0123456789abcdef01234567";
const UPDATE = process.env["UPDATE_RIG_FIXTURES"] === "1";

function normalise(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value).replace(/rb_[0-9a-f]{24}/g, FIXED_ID),
  ) as unknown;
}

function check(name: string, value: unknown): void {
  const file = join(DIR, `${name}.json`);
  const text = JSON.stringify(normalise(value), null, 2) + "\n";
  if (UPDATE) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(file, text);
  }
  expect(readFileSync(file, "utf8")).toBe(text);
}

const part = z.object({
  role: z.string(),
  productId: z.string(),
  variantId: z.number().int(),
  title: z.string(),
  variantTitle: z.string().nullable(),
  url: z.string().nullable(),
  image: z.string().nullable(),
  price: z.string().regex(/^\d+\.\d{2}$/),
  currency: z.string(),
  available: z.boolean(),
  quantity: z.literal(1),
  why: z.string(),
  specs: z.record(z.string(), z.union([z.string(), z.number()])),
});

const buildResponse = z.object({
  requestId: z.string().regex(/^rb_[0-9a-f]{24}$/).optional(),
  profile: z.record(z.string(), z.unknown()),
  needs: z.array(z.string()),
  rigs: z.array(
    z.object({
      label: z.string(),
      items: z.array(part),
      total: z.string(),
      currency: z.string(),
      checks: z.array(z.object({ id: z.string(), ok: z.boolean() })),
      alternatives: z.array(
        z.object({
          role: z.string(),
          variantId: z.number().int(),
          title: z.string(),
          variantTitle: z.string().nullable(),
          price: z.string(),
          currency: z.string(),
          why: z.string(),
        }),
      ),
    }),
  ),
  unmet: z.array(z.object({ role: z.string(), reason: z.string() }).passthrough()),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  mode: z.enum(["ai", "plain"]),
  snapshotAgeMinutes: z.number().nullable(),
});

const explainResponse = z.object({
  requestId: z.string(),
  profile: z.record(z.string(), z.unknown()),
  needs: z.array(z.string()),
  whys: z.record(z.string(), z.string()),
  variantIds: z.array(z.number().int()),
  mode: z.enum(["ai", "plain"]),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
});

describe("contract examples for the theme", () => {
  it("build: request, response, needs, errors", async () => {
    const { api } = setup();
    const request = {
      text: "82 kg, third season, freeride at 15 to 25 knots, I already own a boom",
      answers: { ...REFERENCE, owns: ["boom"], ownedBoomMinCm: 150, ownedBoomMaxCm: 190 },
      locale: "en",
    };
    const response = await api.build(post(request));
    const body = await read(response);
    expect(buildResponse.parse(body)).toBeTruthy();
    check("build-request", request);
    check("build-response", body);

    const needs = await read(await api.build(post({ text: "I want a rig" })));
    expect(buildResponse.parse(needs)).toBeTruthy();
    check("build-response-needs", needs);

    check("error-invalid-body", await read(await api.build(post({ answers: { weightKg: 0 } }))));
    check("error-text-too-long", await read(await api.build(post({ text: "x".repeat(1001) }))));
    check("error-unauthorized", await read(await setup({ authenticate: async () => null }).api.build(post({ answers: REFERENCE }))));

    const off = setup();
    off.store.enabled = false;
    check("error-not-ready", await read(await off.api.build(post({ answers: REFERENCE }))));

    const limited = setup({ buildLimiter: new RateLimiter([{ ms: 60_000, limit: 1 }]) });
    await limited.api.build(post({ answers: REFERENCE }));
    const refused = await limited.api.build(post({ answers: REFERENCE }));
    expect(refused.headers.get("Retry-After")).toBe("60");
    check("error-rate-limited", await read(refused));
  });

  it("explain: ai and plain", async () => {
    const request = { text: "82 kg, intermediate, 15 to 25 knots", answers: { discipline: "windsurf" } };
    const ai = setup({ script: goodModel() });
    const aiBody = await read(await ai.api.explain(post(request)));
    expect(explainResponse.parse(aiBody)).toBeTruthy();
    check("explain-request", request);
    check("explain-response-ai", aiBody);

    const plain = setup({ script: () => fail("exhausted") });
    const plainBody = await read(await plain.api.explain(post({ answers: REFERENCE })));
    expect(explainResponse.parse(plainBody)).toBeTruthy();
    check("explain-response-plain", plainBody);
  });

  it("verify: request and response", async () => {
    const { api } = setup();
    const built = await read(await api.build(post({ answers: REFERENCE })));
    const request = {
      variantIds: built["rigs"][0].items.map((item: { variantId: number }) => item.variantId),
      answers: REFERENCE,
    };
    check("verify-request", request);
    check("verify-response", await read(await api.verify(post(request))));
  });
});
