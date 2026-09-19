import { describe, expect, it } from "vitest";

import {
  campaignWarnings,
  conflictSummary,
  describeFormDiscount,
  discountFromForm,
  exampleFromForm,
  scheduleSummary,
  targetingSummary,
  timeZoneLabel,
} from "~/web/lib/campaign-editor";

/**
 * What the campaign editor's sidebar and result bar say about the form as
 * it is being edited (docs/sale-campaigns.md § UI). Every line is derived
 * from the form's strings, so an unsaved edit is summarised exactly as the
 * saved campaign would be.
 */

const percent = {
  discountType: "percentage" as const,
  discountValue: "10",
  rounding: "none" as const,
  roundingIncrement: "",
};

describe("discountFromForm", () => {
  it("reads a percentage as basis points and an amount as minor units", () => {
    expect(discountFromForm(percent)).toEqual({
      type: "percentage",
      value: 1000,
    });
    expect(
      discountFromForm({
        ...percent,
        discountType: "fixed_amount",
        discountValue: "12,50",
      }),
    ).toEqual({ type: "fixed_amount", value: 1250 });
  });

  it("is null while the value is not a discount yet", () => {
    expect(discountFromForm({ ...percent, discountValue: "" })).toBeNull();
    expect(discountFromForm({ ...percent, discountValue: "0" })).toBeNull();
    expect(discountFromForm({ ...percent, discountValue: "abc" })).toBeNull();
    expect(discountFromForm({ ...percent, discountValue: "150" })).toBeNull();
  });
});

describe("describeFormDiscount", () => {
  it("says the discount the merchant's way, or that there is none yet", () => {
    expect(describeFormDiscount(percent, "EUR")).toBe("10% off");
    expect(
      describeFormDiscount(
        { ...percent, discountType: "fixed_price", discountValue: "99" },
        "EUR",
      ),
    ).toBe("Set to €99.00");
    expect(describeFormDiscount({ ...percent, discountValue: "" }, "EUR")).toBe(
      "No discount yet",
    );
  });
});

describe("exampleFromForm", () => {
  it("shows one of the merchant's prices before and after, with rounding", () => {
    // €1,823.27 − 10 % = €1,640.943 → half up to €1,640.94.
    expect(exampleFromForm(percent, 182_327, "EUR")).toEqual({
      before: "€1,823.27",
      after: "€1,640.94",
    });
    expect(
      exampleFromForm({ ...percent, rounding: "ending_99" }, 182_327, "EUR"),
    ).toEqual({ before: "€1,823.27", after: "€1,639.99" });
    expect(
      exampleFromForm(
        { ...percent, rounding: "increment", roundingIncrement: "5.00" },
        182_327,
        "EUR",
      ),
    ).toEqual({ before: "€1,823.27", after: "€1,640.00" });
  });

  it("shows nothing while the discount is invalid or would not lower the price", () => {
    expect(
      exampleFromForm({ ...percent, discountValue: "" }, 182_327, "EUR"),
    ).toBeNull();
    expect(
      exampleFromForm(
        { ...percent, discountType: "fixed_price", discountValue: "2000" },
        182_327,
        "EUR",
      ),
    ).toBeNull();
  });
});

describe("scheduleSummary", () => {
  const zone = "Europe/Ljubljana";
  const base = {
    startMode: "now" as const,
    startDate: "",
    startTime: "00:00",
    endMode: "none" as const,
    endDate: "",
    endTime: "23:59",
  };

  it("reads a draft that starts on activation and never ends", () => {
    expect(scheduleSummary(base, zone)).toEqual({
      starts: "On activation",
      ends: "No end date",
      line: "Starts on activation · Runs until stopped",
    });
  });

  it("reads the dates in the shop's zone", () => {
    const summary = scheduleSummary(
      {
        ...base,
        startMode: "at",
        startDate: "2026-09-20",
        endMode: "at",
        endDate: "2026-09-30",
      },
      zone,
    );
    expect(summary.starts).toBe("20 Sept 2026, 00:00");
    expect(summary.ends).toBe("30 Sept 2026, 23:59");
    expect(summary.line).toBe(
      "Starts 20 Sept 2026, 00:00 · Ends 30 Sept 2026, 23:59",
    );
  });

  it("says a date is not set rather than guessing one", () => {
    const summary = scheduleSummary(
      { ...base, startMode: "at", endMode: "at" },
      zone,
    );
    expect(summary.starts).toBe("Date not set");
    expect(summary.line).toBe("Start date not set · End date not set");
  });

  it("states when a live campaign started", () => {
    const summary = scheduleSummary(base, zone, {
      status: "active",
      startedAt: "2026-09-19T22:00:00.000Z",
    });
    expect(summary.starts).toBe("20 Sept 2026, 00:00");
    expect(summary.line).toBe(
      "Started 20 Sept 2026, 00:00 · Runs until stopped",
    );
  });
});

describe("conflictSummary", () => {
  it("names the strategy, with the priority only where it matters", () => {
    expect(conflictSummary("prevent", "5")).toBe("Do not overlap");
    expect(conflictSummary("priority", "5")).toBe(
      "Higher priority wins (priority 5)",
    );
    expect(conflictSummary("priority", "")).toBe(
      "Higher priority wins (priority 0)",
    );
  });
});

describe("targetingSummary", () => {
  it("states the counts once, on one line, without an empty exclusion", () => {
    expect(
      targetingSummary({
        products: 342,
        includedVariants: 1028,
        excludedVariants: 12,
        variants: 1016,
      }),
    ).toBe("342 products · 1,028 variants matched · 12 excluded · 1,016 final");
    expect(
      targetingSummary({
        products: 1,
        includedVariants: 1,
        excludedVariants: 0,
        variants: 1,
      }),
    ).toBe("1 product · 1 variant matched · 1 final");
  });
});

describe("timeZoneLabel", () => {
  it("names the zone with its offset at the instant given", () => {
    expect(
      timeZoneLabel("Europe/Ljubljana", new Date("2026-07-01T00:00:00Z")),
    ).toBe("Europe/Ljubljana (UTC+02:00)");
    expect(
      timeZoneLabel("Europe/Ljubljana", new Date("2026-01-01T00:00:00Z")),
    ).toBe("Europe/Ljubljana (UTC+01:00)");
    expect(timeZoneLabel("UTC", new Date("2026-01-01T00:00:00Z"))).toBe(
      "UTC (UTC+00:00)",
    );
  });

  it("falls back to the bare name for a zone it cannot read", () => {
    expect(timeZoneLabel("Not/AZone")).toBe("Not/AZone");
  });
});

describe("campaignWarnings", () => {
  const quiet = {
    conflicts: { refused: 0, taken: 0, lost: 0, holders: [] },
    scheduledOverlaps: [],
    fixedPriceMarkets: [],
    discounts: null,
    campaignHref: (id: string) => `/app/sales/${id}`,
  };

  it("says nothing when there is nothing to say", () => {
    expect(campaignWarnings(quiet)).toEqual([]);
    expect(
      campaignWarnings({
        ...quiet,
        discounts: { kind: "read", discounts: [] },
      }),
    ).toEqual([]);
    expect(
      campaignWarnings({
        ...quiet,
        discounts: { kind: "unavailable", reason: "no scope" },
      }),
    ).toEqual([]);
  });

  it("puts a refused conflict first and marks it critical", () => {
    const warnings = campaignWarnings({
      ...quiet,
      conflicts: { refused: 3, taken: 0, lost: 0, holders: ["Black Friday"] },
      scheduledOverlaps: [
        { campaignId: "c2", name: "Winter", status: "scheduled", variants: 4 },
      ],
      fixedPriceMarkets: [{ name: "Germany", currency: "EUR", fixedPrices: 2 }],
      discounts: {
        kind: "read",
        discounts: [
          {
            id: "d1",
            title: "10% off everything",
            kind: "amount off",
            startsAt: null,
            endsAt: null,
          },
        ],
      },
    });
    expect(warnings.map((w) => [w.key, w.tone])).toEqual([
      ["conflicts", "critical"],
      ["overlap:c2", "warning"],
      ["discounts", "warning"],
      ["markets", "info"],
    ]);
    expect(warnings[0]?.heading).toBe("3 variants held by Black Friday");
    expect(warnings[1]?.link).toEqual({
      href: "/app/sales/c2",
      label: "Open campaign",
    });
    expect(warnings[2]?.heading).toBe("Shopify discount overlap");
    expect(warnings[2]?.link?.href).toBe("shopify://admin/discounts");
  });

  it("describes a contest the strategy resolves as a warning, not a refusal", () => {
    const [warning] = campaignWarnings({
      ...quiet,
      conflicts: { refused: 0, taken: 2, lost: 1, holders: ["Summer"] },
    });
    expect(warning?.tone).toBe("warning");
    expect(warning?.text).toBe(
      "2 would be taken over and 1 left with the other campaign.",
    );
  });
});
