import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TranslateOutcome } from "~/adapters/ai/openai.server";
import type { StoredMemory } from "~/adapters/db/repositories/translation-intelligence.server";
import type * as ShopifyTranslations from "~/adapters/shopify/translations";
import type { TranslatableResource } from "~/adapters/shopify/translations";
import type { Intelligence } from "~/adapters/translations/intelligence.server";
import type { TranslationRequest } from "~/domain/translations/prompt";
import type { StoredTerm } from "~/domain/translations/terminology";
import type { GlossaryTerm, OwnershipRecord, TranslationTrace } from "~/domain/translations/types";
import type { Violation } from "~/domain/translations/validate";
import { serviceToken } from "~/domain/types";
import { WATERSPORTS_MENU } from "../fixtures/translations/snapshots";

/**
 * The engine end to end with a scripted provider (docs/translations.md
 * § The engine): memory answers before the model is asked, the model's
 * answer is validated before Shopify is written, a broken answer is
 * corrected once and refused if it stays broken, a person's translation is
 * never sent back, and every item carries its trace.
 */

const provider = {
  translate: vi.fn<(request: TranslationRequest) => Promise<TranslateOutcome>>(),
  correct: vi.fn<(request: TranslationRequest, previous: string, violations: readonly Violation[]) => Promise<TranslateOutcome>>(),
};
const shopify = { register: vi.fn() };
const repo = { recordOwnership: vi.fn(), glossaryFor: vi.fn() };

vi.mock("~/adapters/ai/openai.server", () => ({
  translateFields: (_principal: unknown, request: TranslationRequest) => provider.translate(request),
  correctFields: (_principal: unknown, request: TranslationRequest, previous: string, violations: readonly Violation[]) =>
    provider.correct(request, previous, violations),
}));
vi.mock("~/adapters/shopify/translations", async (importOriginal) => {
  const original = await importOriginal<typeof ShopifyTranslations>();
  return {
    ...original,
    registerTranslations: (_admin: unknown, resourceId: string, writes: unknown) =>
      shopify.register(resourceId, writes),
  };
});
vi.mock("~/adapters/db/repositories/translations.server", () => ({
  glossaryFor: (...args: unknown[]) => repo.glossaryFor(...args),
  recordOwnership: (...args: unknown[]) => repo.recordOwnership(...args),
}));

const { translateResource, hashValue } = await import("~/adapters/translations/engine.server");

function reply(values: Record<string, string>): TranslateOutcome {
  const translations = Object.fromEntries(Object.values(values).map((value, index) => [String(index + 1), value]));
  return { kind: "ok", values: new Map(Object.entries(values)), model: "test-model", text: JSON.stringify({ translations }) };
}

/** A provider answer keyed by field key, in the order the request lists the fields. */
function answer(byKey: Record<string, string>) {
  return async (request: TranslationRequest): Promise<TranslateOutcome> => {
    const values: Record<string, string> = {};
    for (const field of request.fields) {
      const value = byKey[field.key];
      if (value === undefined) throw new Error(`unscripted field ${field.key}`);
      values[field.key] = value;
    }
    return reply(values);
  };
}

function resource(
  id: string,
  fields: Array<{ key: string; value: string; type?: string }>,
  translations: Record<string, Array<{ key: string; value: string; outdated?: boolean }>> = {},
): TranslatableResource {
  return {
    resourceId: id,
    sourceLocale: "en",
    fields: fields.map((f) => ({ key: f.key, value: f.value, digest: `digest-${f.key}`, type: f.type ?? "STRING" })),
    translations: new Map(
      Object.entries(translations).map(([locale, list]) => [
        locale,
        list.map((t) => ({ key: t.key, value: t.value, outdated: t.outdated ?? false, updatedAt: null })),
      ]),
    ),
  };
}

const remembered = vi.fn();

function intelligence(input: { terms?: StoredTerm[]; memory?: StoredMemory[]; storeContext?: string | null } = {}): Intelligence {
  return {
    storeContext: input.storeContext ?? "A specialist watersports retailer.",
    profileVersion: 3,
    learn: true,
    contexts: {
      prime: async () => {},
      contextFor: async (_id, type) =>
        type === "LINK"
          ? { kind: "menu_item", menuTitle: "Main menu", parents: [], siblings: WATERSPORTS_MENU, children: [], linksTo: "collection" }
          : { kind: "none" },
      neighbourText: async () => [],
    },
    termsFor: async () => input.terms ?? [],
    memoryFor: async () => input.memory ?? [],
    remember: async (...args) => {
      remembered(...args);
    },
  };
}

function term(id: string, termText: string, classification: StoredTerm["classification"], confidence = 0.95): StoredTerm {
  return { id, term: termText, normalised: termText.toLowerCase(), classification, confidence, evidence: { menu: 1 } };
}

function memory(partial: Partial<StoredMemory> & Pick<StoredMemory, "sourceText" | "targetText">): StoredMemory {
  return {
    id: `m-${partial.sourceText}`,
    sourceKey: partial.sourceText.toLowerCase(),
    targetLocale: "sl",
    origin: "ai",
    usageCount: 1,
    resourceType: "LINK",
    ...partial,
  };
}

const admin = {} as AdminApiContext;
const principal = serviceToken("test.myshopify.com", "test");

function ctx(intel: Intelligence, overrides: Partial<Parameters<typeof translateResource>[0]> = {}) {
  return {
    principal,
    admin,
    primaryLocale: "en",
    storeName: "Recharge Watersports",
    syncId: "sync-1",
    mode: "missing" as const,
    requestedBy: null,
    settings: new Map(),
    intelligence: intel,
    ...overrides,
  };
}

async function run(
  intel: Intelligence,
  res: TranslatableResource,
  options: { type?: "LINK" | "PRODUCT"; ownership?: OwnershipRecord[]; glossary?: GlossaryTerm[]; mode?: "missing" | "force"; locales?: string[] } = {},
) {
  return translateResource(ctx(intel, { mode: options.mode ?? "missing" }), {
    resource: res,
    resourceType: options.type ?? "LINK",
    targetLocales: options.locales ?? ["sl"],
    override: null,
    ownership: options.ownership ?? [],
    glossaries: new Map([["sl", options.glossary ?? []]]),
  });
}

function traceOf(outcome: Awaited<ReturnType<typeof run>>): TranslationTrace {
  const trace = outcome.items[0]?.trace;
  if (!trace) throw new Error("no trace");
  return trace;
}

beforeEach(() => {
  provider.translate.mockReset();
  provider.correct.mockReset();
  shopify.register.mockReset().mockResolvedValue({ kind: "ok", written: 1 });
  repo.recordOwnership.mockReset().mockResolvedValue(undefined);
  remembered.mockReset();
});

describe("the engine", () => {
  it("translates a menu link with its siblings, store and terminology in view, then writes, records and remembers", async () => {
    provider.translate.mockImplementation(answer({ title: "Wing" }));
    const outcome = await run(intelligence({ terms: [term("t1", "Wing", "category")] }), resource("gid://shopify/Link/1", [{ key: "title", value: "Wing" }]));

    expect(outcome.translated).toBe(1);
    expect(outcome.failed).toBe(0);
    const request = provider.translate.mock.calls[0]![0];
    expect(request.sourceLocale).toBe("en");
    expect(request.targetLocale).toBe("sl");
    expect(request.resourceContext).toMatchObject({ kind: "menu_item", siblings: WATERSPORTS_MENU });
    expect(request.storeContext).toContain("watersports");
    expect(request.terminology).toEqual([{ term: "Wing", classification: "category", evidence: "menu label" }]);

    expect(shopify.register).toHaveBeenCalledWith("gid://shopify/Link/1", [
      { key: "title", locale: "sl", value: "Wing", digest: "digest-title" },
    ]);
    expect(repo.recordOwnership).toHaveBeenCalledWith(
      principal,
      [expect.objectContaining({ key: "title", locale: "sl", owner: "ai", valueHash: hashValue("Wing"), syncId: "sync-1" })],
      expect.any(Date),
    );
    expect(remembered).toHaveBeenCalledWith(
      { sourceLocale: "en", targetLocale: "sl", resourceType: "LINK", resourceId: "gid://shopify/Link/1", pairs: [{ sourceText: "Wing", targetText: "Wing" }] },
      "ai",
    );
    const trace = traceOf(outcome);
    expect(trace).toMatchObject({
      promptVersion: "translate-v2",
      profileVersion: 3,
      sourceLocale: "en",
      sourceReason: "primary",
      targetLocale: "sl",
      contextKind: "menu_item",
      model: "test-model",
      attempts: 1,
      reusedKeys: [],
      termIds: ["t1"],
      validation: [{ attempt: 1, violations: [{ key: "title", code: "unchanged", severity: "soft" }] }],
    });
    expect(outcome.items[0]?.status).toBe("translated");
  });

  it("answers from memory without asking the model when the answer is established", async () => {
    const intel = intelligence({
      memory: [memory({ sourceText: "Used", targetText: "Rabljeno", origin: "manual" })],
    });
    const outcome = await run(intel, resource("gid://shopify/Link/2", [{ key: "title", value: "Used" }]));
    expect(provider.translate).not.toHaveBeenCalled();
    expect(shopify.register).toHaveBeenCalledWith("gid://shopify/Link/2", [
      { key: "title", locale: "sl", value: "Rabljeno", digest: "digest-title" },
    ]);
    // Nothing new to learn: the answer came from memory.
    expect(remembered).not.toHaveBeenCalled();
    expect(traceOf(outcome)).toMatchObject({ attempts: 0, reusedKeys: ["title"], memoryHitIds: ["m-Used"], model: null });
    expect(outcome.items[0]?.detail).toMatchObject({ reused: 1, translated: 1 });
  });

  it("keeps terminology consistent: a term the store already settled arrives as an established translation", async () => {
    provider.translate.mockImplementation(answer({ title: "Wing Foil komplet", body_html: "<p>Za wing.</p>" }));
    const intel = intelligence({
      memory: [
        memory({ sourceText: "Wing", targetText: "Wing", usageCount: 12, resourceType: "PRODUCT" }),
        // Seen once, on a different kind of content: a hint, not a reuse.
        memory({ sourceText: "Wing Foil Kit", targetText: "Wing Foil komplet", resourceType: "COLLECTION" }),
      ],
    });
    await run(intel, resource("gid://shopify/Product/3", [{ key: "title", value: "Wing Foil Kit" }, { key: "body_html", value: "<p>For wing.</p>", type: "HTML" }]), {
      type: "PRODUCT",
    });
    const request = provider.translate.mock.calls[0]![0];
    expect(request.fields.map((f) => f.key)).toEqual(["title", "body_html"]);
    expect(request.memoryHints.map((h) => `${h.sourceText}→${h.targetText}`)).toEqual(["Wing Foil Kit→Wing Foil komplet", "Wing→Wing"]);
  });

  it("corrects an answer that broke an invariant, and writes the corrected one", async () => {
    provider.translate.mockImplementation(answer({ title: "Vsi izdelki", label: "All Products" }));
    provider.correct.mockImplementation(async (request, previous, violations) => {
      expect(previous).toContain("All Products");
      expect(violations.map((v) => `${v.key}:${v.code}`)).toEqual(["label:unchanged"]);
      return answer({ title: "Vsi izdelki", label: "Vsi izdelki" })(request);
    });
    const outcome = await run(intelligence(), resource("gid://shopify/Link/4", [{ key: "title", value: "All Products" }, { key: "label", value: "All Products" }]));
    expect(provider.correct).toHaveBeenCalledTimes(1);
    expect(outcome.failed).toBe(0);
    expect(shopify.register).toHaveBeenCalledWith("gid://shopify/Link/4", [
      { key: "title", locale: "sl", value: "Vsi izdelki", digest: "digest-title" },
      { key: "label", locale: "sl", value: "Vsi izdelki", digest: "digest-label" },
    ]);
    expect(traceOf(outcome)).toMatchObject({
      attempts: 2,
      validation: [
        { attempt: 1, violations: [{ key: "label", code: "unchanged", severity: "hard" }] },
        { attempt: 2, violations: [] },
      ],
    });
  });

  it("refuses to write an answer that still breaks an invariant after the correction", async () => {
    provider.translate.mockImplementation(answer({ body_html: "<p>Brez povezave</p>" }));
    provider.correct.mockImplementation(answer({ body_html: "<p>Še vedno brez</p>" }));
    const outcome = await run(
      intelligence(),
      resource("gid://shopify/Product/5", [{ key: "body_html", value: '<p>See <a href="https://x.example/spec">the spec</a></p>', type: "HTML" }]),
      { type: "PRODUCT" },
    );
    expect(outcome.failed).toBe(1);
    expect(outcome.items[0]?.status).toBe("failed");
    expect(outcome.items[0]?.error).toContain("body_html: html_structure");
    expect(shopify.register).not.toHaveBeenCalled();
    expect(repo.recordOwnership).not.toHaveBeenCalled();
    expect(remembered).not.toHaveBeenCalled();
    expect(traceOf(outcome).attempts).toBe(2);
  });

  it("gives the merchant's glossary precedence: a remembered answer the glossary contradicts is not reused, and the rule is checked", async () => {
    const glossary: GlossaryTerm[] = [{ kind: "translate", targetLocale: "sl", sourceTerm: "Foil", targetTerm: "Hidrokrilo" }];
    provider.translate.mockImplementation(answer({ title: "Foil" }));
    provider.correct.mockImplementation(answer({ title: "Hidrokrilo" }));
    const intel = intelligence({ memory: [memory({ sourceText: "Foil", targetText: "Foil", origin: "manual" })] });
    const outcome = await run(intel, resource("gid://shopify/Link/6", [{ key: "title", value: "Foil" }]), { glossary });
    expect(provider.translate).toHaveBeenCalledTimes(1);
    expect(provider.translate.mock.calls[0]![0].glossary).toEqual(glossary);
    expect(provider.correct).toHaveBeenCalledTimes(1);
    expect(shopify.register).toHaveBeenCalledWith("gid://shopify/Link/6", [
      { key: "title", locale: "sl", value: "Hidrokrilo", digest: "digest-title" },
    ]);
    expect(traceOf(outcome).glossaryHits).toBe(1);
  });

  it("never sends a person's translation back to the model, even in force mode", async () => {
    provider.translate.mockImplementation(answer({ body_html: "<p>Nov opis</p>" }));
    const ownership: OwnershipRecord[] = [
      { key: "title", locale: "sl", owner: "manual", valueHash: hashValue("Rabljeno") },
      { key: "body_html", locale: "sl", owner: "ai", valueHash: hashValue("<p>Star opis</p>") },
    ];
    const res = resource(
      "gid://shopify/Product/7",
      [{ key: "title", value: "Used" }, { key: "body_html", value: "<p>Old text</p>", type: "HTML" }],
      { sl: [{ key: "title", value: "Rabljeno" }, { key: "body_html", value: "<p>Star opis</p>" }] },
    );
    const outcome = await run(intelligence(), res, { type: "PRODUCT", ownership, mode: "force" });
    const request = provider.translate.mock.calls[0]![0];
    expect(request.fields.map((f) => f.key)).toEqual(["body_html"]);
    expect(outcome.items[0]?.detail).toMatchObject({ skipped: { protected_manual: 1 } });
    expect(shopify.register).toHaveBeenCalledWith("gid://shopify/Product/7", [
      { key: "body_html", locale: "sl", value: "<p>Nov opis</p>", digest: "digest-body_html" },
    ]);
  });

  it("copies a resource written in the target language and records the decided source", async () => {
    const res = resource("gid://shopify/Article/8", [{ key: "title", value: "Rabljena oprema" }]);
    provider.translate.mockImplementation(answer({ title: "Gebrauchte Ausrüstung" }));
    const outcome = await translateResource(ctx(intelligence()), {
      resource: res,
      resourceType: "ARTICLE",
      targetLocales: ["sl", "de"],
      override: {
        id: "o1",
        shopId: "s",
        resourceId: res.resourceId,
        resourceType: "ARTICLE",
        sourceLocale: "sl",
        detectedLocale: "sl",
        detectedConfidence: 0.6,
        setBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      ownership: [],
      glossaries: new Map(),
    });
    const slovenian = outcome.items.find((item) => item.locale === "sl");
    expect(slovenian?.status).toBe("copied");
    // Provider requests happen only for the German item, from Slovenian.
    expect(provider.translate).toHaveBeenCalledTimes(1);
    for (const call of provider.translate.mock.calls) {
      expect(call[0].sourceLocale).toBe("sl");
      expect(call[0].targetLocale).toBe("de");
    }
  });

  it("fails the item, writes nothing and keeps the trace when the provider fails", async () => {
    provider.translate.mockResolvedValue({ kind: "failed", message: "The provider answered 500.", retryable: true });
    const outcome = await run(intelligence(), resource("gid://shopify/Link/9", [{ key: "title", value: "Clothing" }]));
    expect(outcome.failed).toBe(1);
    expect(outcome.items[0]?.error).toBe("The provider answered 500.");
    expect(shopify.register).not.toHaveBeenCalled();
    expect(traceOf(outcome)).toMatchObject({ attempts: 1, model: null });
  });
});
