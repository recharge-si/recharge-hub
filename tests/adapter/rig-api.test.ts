import { describe, expect, it } from "vitest";

import {
  REFERENCE,
  loadCatalogue,
} from "../support/rig-fixtures";
import {
  fail,
  goodModel,
  ok,
  type Json,
  post,
  read,
  setup,
} from "../support/rig-api-harness";

/* --------------------------------- tests ---------------------------------- */

describe("signature and tenant", () => {
  it("answers 401 and runs no engine, store read or model without a valid signature", async () => {
    const { api, store, provider } = setup({ authenticate: async () => null });
    for (const handler of [api.build, api.explain, api.verify]) {
      const response = await handler(post({ answers: REFERENCE }));
      expect(response.status).toBe(401);
    }
    expect(store.loadSource).not.toHaveBeenCalled();
    expect(store.saved).toEqual([]);
    expect(provider.prompts).toEqual([]);
  });

  it("answers 401 when verifying the signature throws", async () => {
    const { api, store } = setup({
      authenticate: async () => {
        throw new Response(null, { status: 400 });
      },
    });
    expect((await api.build(post({ answers: REFERENCE }))).status).toBe(401);
    expect(store.loadSource).not.toHaveBeenCalled();
  });

  it("answers 401 for a shop the app does not know", async () => {
    const { api } = setup({ authenticate: async () => "nobody.myshopify.com" });
    expect((await api.build(post({ answers: REFERENCE }))).status).toBe(401);
  });

  it("never returns shop A products to shop B", async () => {
    const a = setup();
    const resultA = await read(await a.api.build(post({ answers: REFERENCE })));
    const idsA = new Set<number>(resultA["rigs"][0].items.map((i: Json) => i.variantId));
    expect(idsA.size).toBeGreaterThan(0);

    const b = setup({ authenticate: async () => "b.myshopify.com" });
    const responseB = await b.api.build(post({ answers: REFERENCE }));
    // Shop B holds two products: not ready, and certainly none of A's.
    expect(responseB.status).toBe(409);
    expect(JSON.stringify(await responseB.json())).not.toContain("Aero Ride");
    expect(b.store.loadSource).toHaveBeenCalledWith("b.myshopify.com");
  });

  it("refuses a GET with 405", async () => {
    const { api } = setup();
    const response = await api.build(new Request("https://hub.test/proxy/rig/build"));
    expect(response.status).toBe(405);
  });
});

describe("an unreadable catalogue", () => {
  it("answers 409 unavailable, logs the cause and never a 5xx, on every handler", async () => {
    const logged: Array<{ fields: Record<string, unknown>; message: string }> = [];
    const { api, store } = setup({
      logError: (fields, message) => logged.push({ fields, message }),
    });
    store.loadSource.mockRejectedValue(
      Object.assign(new Error("The column `catalog_variant.options` does not exist"), {
        code: "P2022",
      }),
    );
    const calls: Array<[(request: Request) => Promise<Response>, unknown]> = [
      [api.build, { answers: REFERENCE }],
      [api.explain, { answers: REFERENCE }],
      [api.verify, { variantIds: [1], answers: REFERENCE }],
    ];
    for (const [handler, body] of calls) {
      const response = await handler(post(body));
      expect(response.status).toBe(409);
      expect(response.headers.get("Retry-After")).toBe("30");
      expect(await response.json()).toEqual({ code: "unavailable" });
    }
    expect(logged).toHaveLength(3);
    expect(logged[0]?.message).toBe("The rig catalogue could not be read");
    expect(logged[0]?.fields).toMatchObject({
      domain: "a.myshopify.com",
      error: { code: "P2022" },
    });
  });
});

describe("the catalogue cache", () => {
  it("reads the catalogue once while it is fresh", async () => {
    const { api, store } = setup();
    await api.build(post({ answers: REFERENCE }));
    await api.build(post({ answers: REFERENCE }));
    expect(store.loadSource).toHaveBeenCalledTimes(1);
  });

  it("serves the old catalogue at once when it is stale, and refreshes in the background", async () => {
    const { api, store, clock } = setup();
    const first = await read(await api.build(post({ answers: REFERENCE })));
    expect(store.loadSource).toHaveBeenCalledTimes(1);

    // The refresh is held back: the buyer must not wait for it.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = store.loadSource.getMockImplementation();
    store.loadSource.mockImplementation(async (domain: string) => {
      await held;
      return (original as (d: string) => ReturnType<typeof store.loadSource>)(domain);
    });

    clock.ms += 61_000;
    const second = await read(await api.build(post({ answers: REFERENCE })));
    expect(second["rigs"][0].items.map((i: Json) => i.variantId)).toEqual(
      first["rigs"][0].items.map((i: Json) => i.variantId),
    );
    // A second request while it refreshes joins that refresh instead of starting another.
    await api.build(post({ answers: REFERENCE }));
    expect(store.loadSource).toHaveBeenCalledTimes(2);
    release();
  });
});

describe("validation", () => {
  it("413 for text over 1000 characters, 200 at exactly 1000", async () => {
    const { api } = setup();
    const long = await api.build(post({ text: "x".repeat(1001), answers: REFERENCE }));
    expect(long.status).toBe(413);
    const edge = await api.build(post({ text: "x".repeat(1000), answers: REFERENCE }));
    expect(edge.status).toBe(200);
  });

  it.each([0, 400, "heavy", null])("400 naming weightKg for %j", async (weight) => {
    const { api } = setup();
    const response = await api.build(post({ answers: { weightKg: weight } }));
    expect(response.status).toBe(400);
    expect((await read(response))["field"]).toBe("answers.weightKg");
  });

  it("400 for unknown keys, naming the key", async () => {
    const { api } = setup();
    const top = await api.build(post({ answers: REFERENCE, shopId: "other" }));
    expect(top.status).toBe(400);
    expect((await read(top))["field"]).toBe("shopId");
    const inner = await api.build(post({ answers: { ...REFERENCE, color: "red" } }));
    expect((await read(inner))["field"]).toBe("answers.color");
  });

  it("400 for a body with neither text nor answers, and for bad JSON", async () => {
    const { api } = setup();
    expect((await api.build(post({}))).status).toBe(400);
    expect((await api.build(post({ text: "  ", answers: {} }))).status).toBe(400);
    expect((await api.build(post("{nope"))).status).toBe(400);
  });
});

describe("rate limit", () => {
  it("allows 3 explains a minute and 10 an hour, then 429 with Retry-After", async () => {
    const { api, clock } = setup();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push((await api.explain(post({ answers: REFERENCE }))).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);

    // Ten in the hour: three per minute, minutes apart.
    let allowed = 3;
    while (allowed < 10) {
      clock.ms += 61_000;
      for (let i = 0; i < 3 && allowed < 10; i += 1) {
        expect((await api.explain(post({ answers: REFERENCE }))).status).toBe(200);
        allowed += 1;
      }
    }
    clock.ms += 61_000;
    const eleventh = await api.explain(post({ answers: REFERENCE }));
    expect(eleventh.status).toBe(429);
    expect(Number(eleventh.headers.get("Retry-After"))).toBeGreaterThan(60);
  });

  it("counts each caller on its own", async () => {
    const { api } = setup();
    for (let i = 0; i < 3; i += 1) await api.explain(post({ answers: REFERENCE }));
    const other = await api.explain(
      post({ answers: REFERENCE }, { "X-Forwarded-For": "198.51.100.7" }),
    );
    expect(other.status).toBe(200);
  });

  it("stores the caller only as a salted hash", async () => {
    const { api, store } = setup();
    await api.build(post({ answers: REFERENCE }));
    const hash = store.saved[0]?.write.ipHash ?? "";
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(store.saved)).not.toContain("203.0.113.9");
  });
});

describe("build", () => {
  it("returns a schema-valid rig, never calls a model, and sets safe headers", async () => {
    const { api, provider, store } = setup();
    const response = await api.build(post({ text: "ignored here", answers: REFERENCE }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const body = await read(response);
    expect(body["requestId"]).toMatch(/^rb_[0-9a-f]{24}$/);
    expect(body["mode"]).toBe("plain");
    expect(body["needs"]).toEqual([]);
    const rig = body["rigs"][0];
    expect(rig["label"]).toBe("Recommended");
    expect(rig["items"]).toHaveLength(6);
    for (const item of rig["items"]) {
      expect(typeof item["variantId"]).toBe("number");
      expect(item["price"]).toMatch(/^\d+\.\d{2}$/);
      expect(item["available"]).toBe(true);
      expect(item["quantity"]).toBe(1);
      expect(typeof item["why"]).toBe("string");
    }
    expect(rig["checks"].every((c: Json) => c.ok)).toBe(true);
    expect(rig["total"]).toMatch(/^\d+\.\d{2}$/);
    expect(body["profile"]["source"]["weightKg"]).toBe("form");
    expect(provider.prompts).toEqual([]);
    expect(store.saved[0]?.write.variantIds).toHaveLength(6);
    // No raw buyer text reaches storage.
    expect(JSON.stringify(store.saved)).not.toContain("ignored here");
  });

  it("asks for the weight when there is none", async () => {
    const { api } = setup();
    const body = await read(await api.build(post({ text: "I want a rig" })));
    expect(body["needs"]).toEqual(["weightKg"]);
    expect(body["rigs"]).toEqual([]);
  });

  it("updates the same request row when the live rig sends its id back", async () => {
    const { api, store } = setup();
    const first = await read(await api.build(post({ answers: REFERENCE })));
    await api.build(post({ answers: { ...REFERENCE, weightKg: 90 }, requestId: first["requestId"] }));
    expect(store.saved.map((s) => s.existing)).toEqual([false, true]);
    expect(store.saved[1]?.write.id).toBe(first["requestId"]);
  });

  it("409 not_ready when the builder is off or the catalogue is not ready", async () => {
    const off = setup();
    off.store.enabled = false;
    const response = await off.api.build(post({ answers: REFERENCE }));
    expect(response.status).toBe(409);
    expect(await read(response)).toMatchObject({ code: "not_ready", reason: "disabled" });
  });

  it("flags a snapshot older than 30 minutes", async () => {
    const { api, clock } = setup();
    clock.ms = Date.parse("2026-10-28T13:30:00Z");
    const body = await read(await api.build(post({ answers: REFERENCE })));
    expect(body["warnings"].map((w: Json) => w.code)).toContain("stale_snapshot");
    expect(body["rigs"][0]["items"][0]["checkAvailability"]).toBe(true);
    expect(body["snapshotAgeMinutes"]).toBe(90);
  });
});

describe("explain", () => {
  it("reads the text, writes the reasons and keeps the rig the engine chose", async () => {
    const { api, provider } = setup();
    const plainBuild = await read(await api.build(post({ answers: REFERENCE })));
    const body = await read(
      await api.explain(post({ text: "82 kg intermediate", answers: { discipline: "windsurf" } })),
    );
    expect(body["mode"]).toBe("ai");
    expect(body["profile"]["source"]["weightKg"]).toBe("text");
    expect(provider.prompts).toHaveLength(2);
    const ids = plainBuild["rigs"][0]["items"].map((i: Json) => String(i.variantId));
    expect(Object.keys(body["whys"]).sort()).toEqual([...ids].sort());
    expect(body["variantIds"].map(String).sort()).toEqual([...ids].sort());
  });

  it("gives the same SKUs and total in ai and plain mode", async () => {
    const ai = setup();
    const plain = setup({ script: () => fail("exhausted") });
    const a = await read(await ai.api.explain(post({ answers: REFERENCE })));
    const p = await read(await plain.api.explain(post({ answers: REFERENCE })));
    expect(a["mode"]).toBe("ai");
    expect(p["mode"]).toBe("plain");
    expect(p["variantIds"]).toEqual(a["variantIds"]);
    expect(p["warnings"].map((w: Json) => w.code)).toContain("mode_plain");
    expect(Object.keys(p["whys"]).sort()).toEqual(Object.keys(a["whys"]).sort());
    // Both buildings of the rig are the same rig.
    const buildA = await read(await ai.api.build(post({ answers: REFERENCE })));
    const buildP = await read(await plain.api.build(post({ answers: REFERENCE })));
    expect(buildP["rigs"][0]["total"]).toBe(buildA["rigs"][0]["total"]);
  });

  it.each(["timeout", "busy", "exhausted"] as const)(
    "falls back to plain mode on %s",
    async (reason) => {
      const { api } = setup({ script: () => fail(reason) });
      const body = await read(
        await api.explain(post({ text: "82 kg", answers: REFERENCE })),
      );
      expect(body["mode"]).toBe("plain");
      const codes = body["warnings"].map((w: Json) => w.code);
      expect(codes).toEqual(expect.arrayContaining(["mode_plain", "text_not_read"]));
      expect(body["variantIds"]).toHaveLength(6);
    },
  );

  it("retries a transient error once, never an exhausted pool", async () => {
    let calls = 0;
    const flaky = setup({
      script: (prompt) => {
        calls += 1;
        return calls === 1 ? fail("error") : goodModel()(prompt);
      },
    });
    await flaky.api.explain(post({ answers: REFERENCE }));
    expect(calls).toBe(2);

    calls = 0;
    const exhausted = setup({ script: () => (calls += 1, fail("exhausted")) });
    await exhausted.api.explain(post({ text: "x", answers: REFERENCE }));
    // One call for the text and one for the words, no retries.
    expect(calls).toBe(2);
  });

  it("makes zero provider calls once the daily budget is spent, and still answers", async () => {
    const { api, store, provider } = setup({ dailyCalls: 500 });
    store.poolCalls = 500;
    const body = await read(await api.explain(post({ text: "82 kg", answers: REFERENCE })));
    expect(provider.prompts).toEqual([]);
    expect(body["mode"]).toBe("plain");
    expect(body["variantIds"]).toHaveLength(6);
  });

  it("does not call the model when the installed claude cannot turn tools off", async () => {
    const { api, provider } = setup();
    provider.isReady = false;
    const body = await read(await api.explain(post({ answers: REFERENCE })));
    expect(provider.prompts).toEqual([]);
    expect(body["mode"]).toBe("plain");
  });

  it("writes an ai_usage row for each spawn, with the outcome", async () => {
    const { api, store } = setup({ script: (p) => (p.includes("<buyer_text>") ? fail("timeout") : goodModel()(p)) });
    await api.explain(post({ text: "82 kg", answers: REFERENCE }));
    expect(store.usage.map((u) => [u.purpose, u.outcome, u.result])).toEqual([
      ["rig_profile", "timeout", "failed"],
      ["rig_why", "ok", "ok"],
    ]);
  });

  it("replaces a sentence that names another product, links, or is too long", async () => {
    const catalogue = loadCatalogue();
    const sail = catalogue.find((p) => p.title === "Aero Ride");
    const sailId = String(
      Number(
        (
          sail?.variants.find((v) => v.title?.startsWith("5.8"))?.variantId ?? ""
        )
          .split("/")
          .pop(),
      ),
    );
    const { api } = setup({
      script: (prompt) => {
        const ids = [...prompt.matchAll(/^- id (\d+):/gm)].map((m) => m[1] as string);
        const whys: Record<string, string> = {};
        for (const id of ids) whys[id] = `Fine reason ${id}.`;
        whys[sailId] = "Better than the Wave Blade for you.";
        const other = ids.find((id) => id !== sailId) as string;
        whys[other] = "See https://evil.example for more";
        return ok({ whys });
      },
    });
    const body = await read(await api.explain(post({ answers: REFERENCE })));
    expect(body["whys"][sailId]).toBe("A 5.8 m² sail suits 82 kg riders in 15–25 knots.");
    const ids = Object.keys(body["whys"]);
    expect(ids.filter((id) => !String(body["whys"][id]).startsWith("Fine reason")).length).toBe(2);
  });

  it("never sends the caller address, cookies or ids to the model", async () => {
    const { api, provider } = setup();
    await api.explain(
      post(
        { text: "82 kg, mail me at buyer@example.com", answers: REFERENCE },
        { Cookie: "cart=abc123", "X-Customer-Id": "987654" },
      ),
    );
    const sent = provider.prompts.join("\n");
    expect(provider.prompts.length).toBeGreaterThan(0);
    expect(sent).not.toMatch(/203\.0\.113\.9|cart=abc123|987654|buyer@example\.com/);
  });

  it("reports needs and no rig when nothing yields a weight", async () => {
    const { api } = setup({ script: () => ok({ skill: "advanced" }) });
    const body = await read(await api.explain(post({ text: "I ride a lot" })));
    expect(body["needs"]).toEqual(["weightKg"]);
    expect(body["variantIds"]).toEqual([]);
  });
});

describe("verify", () => {
  it("returns the checks buildRig produced for the same parts", async () => {
    const { api } = setup();
    const built = await read(await api.build(post({ answers: REFERENCE })));
    const rig = built["rigs"][0];
    const ids = rig["items"].map((i: Json) => i["variantId"]);
    const verified = await read(
      await api.verify(post({ variantIds: ids, answers: REFERENCE })),
    );
    expect(verified["ok"]).toBe(true);
    expect(verified["checks"]).toEqual(rig["checks"]);
    expect(verified["total"]).toBe(rig["total"]);
  });

  it("fails an incompatible swap and an unknown variant", async () => {
    const { api } = setup();
    const built = await read(await api.build(post({ answers: REFERENCE })));
    const items = built["rigs"][0]["items"] as Json[];
    const powerFin = loadCatalogue().find((p) => p.title === "Power Fin 36");
    const powerId = Number(powerFin?.variants[0]?.variantId.split("/").pop());
    const ids = items.map((i) => (i.role === "fin" ? powerId : i.variantId));
    const verified = await read(await api.verify(post({ variantIds: ids, answers: REFERENCE })));
    expect(verified["ok"]).toBe(false);
    expect(verified["checks"].find((c: Json) => c.id === "fin-box").ok).toBe(false);

    const unknown = await read(await api.verify(post({ variantIds: [1], answers: REFERENCE })));
    expect(unknown["ok"]).toBe(false);
  });
});
