import { describe, expect, it } from "vitest";

import { APP_NAV } from "~/web/lib/navigation";

import { PENDING } from "./ui-rules-pending";
import { judge, webLines, type Allowed, type Line } from "./ui-rules";

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
  /** Text a merchant reads: quoted strings with a space, and JSX text. */
  function copyOf(l: Line): string[] {
    if (/^(import|export \* from)\b/.test(l.text) || /\bfrom "/.test(l.text))
      return [];
    const out: string[] = [];
    for (const m of l.text.matchAll(/"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
      const s = m[1] ?? m[2] ?? "";
      if (s.includes(" ")) out.push(s);
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
        [...(PENDING[name] ?? [])],
      );
    });
  }
});
