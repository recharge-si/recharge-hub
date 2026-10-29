import { describe, expect, it } from "vitest";

import { APP_NAV } from "~/web/lib/navigation";

import { PENDING } from "./ui-rules-pending";
import {
  judge,
  loaderLines,
  webLines,
  type Allowed,
  type Line,
} from "./ui-rules";

/**
 * docs/ui-conventions.md as tests (tasks/prd-03-ui-coherence.md § 8).
 *
 * Each rule scans the merchant UI's source and fails with `file:line`, so the
 * next violation names itself. An allowlist entry carries a reason; an entry
 * that no longer excuses anything fails too, so a fixed violation leaves the
 * list and the list can only shrink.
 */
const lines = webLines();
const hit = (test: (l: Line) => boolean): Line[] => lines.filter(test);

function expectClean(hits: Line[], allow: readonly Allowed[]): void {
  const { violations, stale } = judge(hits, allow);
  expect(violations, "violations").toEqual([]);
  expect(stale, "allowlist entries that excuse nothing").toEqual([]);
}

describe("US-302 the navigation tree is pinned", () => {
  it("lists the entries in this order", () => {
    expect(APP_NAV.map((item) => item.label)).toEqual([
      "Home",
      "Needs attention",
      "Orders",
      "Sales",
      "Products",
      "Product setup",
      "Translations",
      "Sources",
      "MetaKocka",
      "Settings",
    ]);
  });
});

describe("US-301 one name for the area", () => {
  it("labels the navigation entry Product setup, never Metafields", () => {
    const entry = APP_NAV.find((item) => item.href === "/app/product-setup");
    expect(entry?.label).toBe("Product setup");
    expect(APP_NAV.map((item) => item.label)).not.toContain("Metafields");
  });

  it("uses Metafields as a name only where Shopify's own concept is meant", () => {
    // Allowlist: lines where the word is Shopify's concept, with the reason.
    const allow: Allowed[] = [];
    expectClean(
      hit((l) => /\bMetafields\b/.test(l.text) && !/^import\b/.test(l.text)),
      allow,
    );
  });
});

describe("US-304 one polling hook", () => {
  const allow: Allowed[] = [
    {
      file: "src/web/lib/live.ts",
      includes: "setInterval(",
      reason: "the one polling hook",
    },
    {
      file: "src/web/components/maintenance-banner.tsx",
      includes: "setInterval(",
      reason:
        "reads a static file on another origin; there is no loader to revalidate",
    },
    {
      file: "src/web/routes/app.metakocka.locations.settings.tsx",
      includes: "const timer = setInterval(() => {",
      reason:
        "waits up to a second for a web component to upgrade so its dialog can open; reads no data",
    },
  ];
  it("keeps setInterval and hand-rolled polling hooks out of routes and components", () => {
    expectClean(
      hit((l) => /\bsetInterval\(|\buseLivePolling\b/.test(l.text)),
      allow,
    );
  });
});

describe("US-305 colour marks exceptions only", () => {
  const allow: Allowed[] = [
    {
      file: "src/web/lib/orders.ts",
      includes: 'tone: "success"',
      reason:
        "Paid is green on the merchant's own request (documented in lib/orders.ts): the one fact they scan the orders list for",
    },
    {
      file: "src/web/lib/orders.ts",
      includes: "export type Tone",
      reason: "the tone type the Paid entry is typed with",
    },
    {
      file: "src/web/routes/app.orders.$orderId.tsx",
      includes: 'payment.status === "success"',
      reason: "compares MetaKocka's payment status value; not a colour",
    },
  ];
  it("has no success or positive tone where a badge, banner or icon takes one", () => {
    expectClean(
      hit((l) => /["'](success|positive)["']/.test(l.text)),
      allow,
    );
  });
});

describe("US-303 one process header", () => {
  const allow: Allowed[] = [
    {
      file: "src/web/components/sources-list.tsx",
      includes: '>Last run</s-table-header>',
      reason: "a column of per-source values in the table, not a page header",
    },
    {
      file: "src/web/components/sources-list.tsx",
      includes: '>Next run</s-table-header>',
      reason: "a column of per-source values in the table, not a page header",
    },
  ];
  it("renders last and next run in the process header only", () => {
    expectClean(
      hit((l) => /["'>]\s*(Last|Next) run\b/.test(l.text)),
      allow,
    );
  });
});

describe("US-308 words", () => {
  const shopifyArticle = "Shopify's own blog article resource, named as Shopify names it";
  const allowByWord: Record<string, Allowed[]> = {
    article: [
      { file: "src/web/components/ai-translation-settings.tsx", includes: "Collections, pages, articles", reason: shopifyArticle },
      { file: "src/web/routes/app.translations._index.tsx", includes: "A page, product or article written", reason: shopifyArticle },
      { file: "src/web/routes/app.translations.add.tsx", includes: "Every product, collection, page, article", reason: shopifyArticle },
      { file: "src/web/routes/app.translations.languages.$locale.tsx", includes: "Shopify \u2014 products, collections, pages, articles", reason: shopifyArticle },
    ],
    exception: [
      { file: "src/web/routes/app.product-setup.settings.tsx", includes: "every set and every exception", reason: "an exception to an inherited attribute rule in product setup: a different concept from the needs-attention queue" },
      { file: "src/web/routes/app.product-setup.types.($typeId).tsx", includes: "has no children, sources or exceptions", reason: "an exception to an inherited attribute rule in product setup: a different concept from the needs-attention queue" },
    ],
    feed: [
      { file: "src/web/lib/empty-states.ts", includes: "a brand feed", reason: "the Sources area's own noun for a kind of source (docs/ui-conventions.md glossary)" },
    ],
  };
  /** Text a merchant reads: quoted strings with a space, and JSX text. */
  function copyOf(l: Line): string[] {
    if (/^(import|export \* from)\b/.test(l.text) || /\bfrom "/.test(l.text))
      return [];
    const out: string[] = [];
    for (const m of l.text.matchAll(/"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
      const s = (m[1] ?? m[2] ?? "").replace(/\$\{[^}]*\}/g, "");
      if (s.includes(" ") && !s.startsWith("/")) out.push(s);
    }
    for (const m of l.text.matchAll(/>([^<>{}]+)</g)) out.push(m[1] ?? "");
    if (/^[A-Z][^{}<>=;()]*[.,:]?$/.test(l.text) && l.text.includes(" "))
      out.push(l.text);
    return out;
  }
  const forbidden: Array<[string, RegExp]> = [
    ["article", /\barticles?\b/i],
    ["exception", /\bexceptions?\b/],
    ["blocked", /\bblocked\b/i],
    ["successfully", /\bsuccessfully\b/i],
    ["feed", /\bfeeds?\b/i],
    ["exclamation", /[A-Za-z]!(\s|$)/],
  ];
  for (const [name, pattern] of forbidden) {
    it(`never says ${name} in merchant copy`, () => {
      expectClean(
        hit((l) => copyOf(l).some((s) => pattern.test(s))),
        [...(allowByWord[name] ?? []), ...(PENDING[name] ?? [])],
      );
    });
  }
});

describe("US-307 no page load waits for an integration", () => {
  const portal =
    "the export portal read is awaited in the loader on purpose (docs/sources.md: one call per page, 8 s timeout). PRD 3 Open question 2 proposes deferring it; not done blind, without a browser to check the live re-reads and the failure states";
  const allow: Allowed[] = [
    { file: "src/web/routes/app.sources._index.tsx", includes: "readPortal(", reason: portal },
    { file: "src/web/routes/app.sources.$sourceId._index.tsx", includes: "readPortal(", reason: portal },
    { file: "src/web/routes/app.sources.$sourceId.runs._index.tsx", includes: "readPortal(", reason: portal },
    { file: "src/web/routes/app.sources.$sourceId.runs.$runId.tsx", includes: "readPortal(", reason: portal },
    { file: "src/web/routes/app.sources.new.tsx", includes: "readPortal(", reason: portal },
    { file: "src/web/routes/app.sources.categorization.tsx", includes: "readPortal(", reason: portal },
    { file: "src/web/routes/app.sources.review.tsx", includes: "readPortal(", reason: portal },
  ];
  it("keeps MetaKocka and the export portal out of loaders, except the documented portal reads", () => {
    expectClean(
      loaderLines().filter((l) =>
        /\bnew MetakockaClient\(|\breadPortal\(|\bportalFor\(/.test(l.text),
      ),
      allow,
    );
  });
});

describe("US-304 the nine polling routes use the hook", () => {
  const ROUTES = [
    "app.sales._index.tsx",
    "app.sales.$campaignId._index.tsx",
    "app.translations._index.tsx",
    "app.translations.syncs._index.tsx",
    "app.translations.syncs.$syncId.tsx",
    "app.translations.context.tsx",
    "app.translations.languages.$locale.tsx",
    "app.metakocka.locations.settings.tsx",
    "app.orders.settings.payments.tsx",
  ];
  for (const route of ROUTES)
    it(`${route} calls useLiveRevalidation`, () => {
      const file = `src/web/routes/${route}`;
      expect(
        lines.some((l) => l.file === file && /useLiveRevalidation\(/.test(l.text)),
      ).toBe(true);
    });
  it("uses useWatchWindow in the payments page after a save", () => {
    expect(
      lines.some(
        (l) =>
          l.file === "src/web/routes/app.orders.settings.payments.tsx" &&
          /useWatchWindow\(/.test(l.text),
      ),
    ).toBe(true);
  });
});

describe("US-311 empty states live in one file", () => {
  it("does not repeat an empty-state sentence anywhere else", async () => {
    const { EMPTY } = await import("~/web/lib/empty-states");
    const sentences: string[] = [];
    for (const value of Object.values(EMPTY))
      sentences.push(...(typeof value === "string" ? [value] : Object.values(value)));
    const repeats = hit(
      (l) =>
        l.file !== "src/web/lib/empty-states.ts" &&
        // Only the long ones: "No products match." is a fair answer elsewhere.
        sentences.some((s) => s.length > 40 && l.text.includes(s)),
    ).map((l) => `${l.file}:${l.line}  ${l.text.slice(0, 100)}`);
    expect(repeats).toEqual([]);
  });
});
