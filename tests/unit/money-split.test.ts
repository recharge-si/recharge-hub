import { describe, expect, it } from "vitest";

import {
  negativeShares,
  proportionalSplit,
  splitOrderMoney,
  type SourceLineTotal,
} from "~/domain/money/split";

/**
 * CLAUDE.md section 8.6: the documents must sum to the Shopify order total
 * exactly, including odd cents and three-way splits. A one-cent drift becomes a
 * manual reconciliation for a human being, so the sum is asserted on every case
 * rather than spot-checked.
 */

function part(over: Partial<SourceLineTotal> = {}): SourceLineTotal {
  return {
    sourceId: "own-1",
    sourceCode: "OWN",
    kind: "own",
    lineTotalMinor: 1000,
    ...over,
  };
}

const sum = (shares: { totalMinor: number }[]) =>
  shares.reduce((total, share) => total + share.totalMinor, 0);

describe("choosing the primary document", () => {
  it("picks the largest line total", () => {
    const shares = splitOrderMoney({
      perSource: [
        part({ sourceId: "a", sourceCode: "A", lineTotalMinor: 500 }),
        part({ sourceId: "b", sourceCode: "B", lineTotalMinor: 2500 }),
      ],
      orderTotalMinor: 3000,
      shippingMinor: 0,
      discountMinor: 0,
    });

    expect(shares.find((s) => s.isPrimary)?.sourceId).toBe("b");
    expect(shares.filter((s) => s.isPrimary)).toHaveLength(1);
  });

  it("breaks a tie with own before partner", () => {
    const shares = splitOrderMoney({
      perSource: [
        part({
          sourceId: "p",
          sourceCode: "AAA",
          kind: "partner",
          lineTotalMinor: 1000,
        }),
        part({ sourceId: "o", sourceCode: "ZZZ", lineTotalMinor: 1000 }),
      ],
      orderTotalMinor: 2000,
      shippingMinor: 0,
      discountMinor: 0,
    });

    expect(shares.find((s) => s.isPrimary)?.sourceId).toBe("o");
  });

  it("breaks a full tie by source code, so retries agree", () => {
    const shares = splitOrderMoney({
      perSource: [
        part({ sourceId: "b", sourceCode: "BBB" }),
        part({ sourceId: "a", sourceCode: "AAA" }),
      ],
      orderTotalMinor: 2000,
      shippingMinor: 0,
      discountMinor: 0,
    });

    expect(shares.find((s) => s.isPrimary)?.sourceId).toBe("a");
  });
});

describe("shipping and discounts", () => {
  it("spreads shipping by merchandise value, summing to the charge exactly", () => {
    /*
     * Shipping used to sit entirely on the primary document. It never
     * duplicated — which is the property that actually matters — but it put the
     * whole postage of a split order on whichever warehouse happened to hold
     * the most. Spread by value, a document's non-product money matches the
     * trade it carries.
     */
    const shares = splitOrderMoney({
      perSource: [
        part({ sourceId: "a", sourceCode: "A", lineTotalMinor: 3000 }),
        part({ sourceId: "b", sourceCode: "B", lineTotalMinor: 1000 }),
      ],
      orderTotalMinor: 4500,
      shippingMinor: 500,
      discountMinor: 0,
    });

    const a = shares.find((s) => s.sourceCode === "A")!;
    const b = shares.find((s) => s.sourceCode === "B")!;

    // 3:1 by value.
    expect(a.shippingMinor).toBe(375);
    expect(b.shippingMinor).toBe(125);
    // The one thing that must never change: charged once, in total.
    expect(a.shippingMinor + b.shippingMinor).toBe(500);
    expect(sum(shares)).toBe(4500);
  });

  it("matches the brief's worked example", () => {
    // A 100 / B 200 merchandise, 15 shipping, 30 discount => A 5/10, B 10/20.
    const shares = splitOrderMoney({
      perSource: [
        part({ sourceId: "a", sourceCode: "A", lineTotalMinor: 10_000 }),
        part({ sourceId: "b", sourceCode: "B", lineTotalMinor: 20_000 }),
      ],
      orderTotalMinor: 28_500,
      shippingMinor: 1_500,
      discountMinor: 3_000,
    });

    const a = shares.find((s) => s.sourceCode === "A")!;
    const b = shares.find((s) => s.sourceCode === "B")!;

    expect(a.shippingMinor).toBe(500);
    expect(b.shippingMinor).toBe(1_000);
    expect(a.discountMinor).toBe(1_000);
    expect(b.discountMinor).toBe(2_000);
    expect(sum(shares)).toBe(28_500);
  });

  it("allocates an awkward remainder exactly once, deterministically", () => {
    const build = (order: "ab" | "ba") => {
      const a = part({ sourceId: "a", sourceCode: "A", lineTotalMinor: 1000 });
      const b = part({ sourceId: "b", sourceCode: "B", lineTotalMinor: 1000 });
      const c = part({ sourceId: "c", sourceCode: "C", lineTotalMinor: 1000 });
      return splitOrderMoney({
        perSource: order === "ab" ? [a, b, c] : [c, b, a],
        orderTotalMinor: 3100,
        shippingMinor: 100,
        discountMinor: 0,
      });
    };

    const forwards = build("ab");
    const backwards = build("ba");

    // 100 over three equal parts: 34/33/33 in some order, and the same order
    // however the caller happened to arrange the array.
    expect(
      forwards.reduce((total, share) => total + share.shippingMinor, 0),
    ).toBe(100);
    for (const code of ["A", "B", "C"]) {
      expect(forwards.find((s) => s.sourceCode === code)!.shippingMinor).toBe(
        backwards.find((s) => s.sourceCode === code)!.shippingMinor,
      );
    }
  });

  it("puts a charge on the primary when every document is worth nothing", () => {
    const shares = splitOrderMoney({
      perSource: [
        part({ sourceId: "a", sourceCode: "A", lineTotalMinor: 0 }),
        part({ sourceId: "b", sourceCode: "B", lineTotalMinor: 0 }),
      ],
      orderTotalMinor: 500,
      shippingMinor: 500,
      discountMinor: 0,
    });

    expect(
      shares.reduce((total, share) => total + share.shippingMinor, 0),
    ).toBe(500);
    expect(shares.find((s) => s.isPrimary)!.shippingMinor).toBe(500);
  });

  it("spreads an order-level discount the same way", () => {
    const shares = splitOrderMoney({
      perSource: [
        part({ sourceId: "a", sourceCode: "A", lineTotalMinor: 3000 }),
        part({ sourceId: "b", sourceCode: "B", lineTotalMinor: 1000 }),
      ],
      orderTotalMinor: 3600,
      shippingMinor: 0,
      discountMinor: 400,
    });

    const a = shares.find((s) => s.sourceCode === "A")!;
    const b = shares.find((s) => s.sourceCode === "B")!;

    // 3:1 by value, and deducted once in total.
    expect(a.discountMinor).toBe(300);
    expect(b.discountMinor).toBe(100);
    expect(a.discountMinor + b.discountMinor).toBe(400);
    expect(a.totalMinor).toBe(2700);
    expect(sum(shares)).toBe(3600);
  });
});

describe("the documents always sum to the order total", () => {
  const cases: {
    name: string;
    totals: number[];
    orderTotal: number;
    shipping: number;
    discount: number;
  }[] = [
    {
      name: "single source",
      totals: [1999],
      orderTotal: 1999,
      shipping: 0,
      discount: 0,
    },
    {
      name: "two-way even",
      totals: [1000, 1000],
      orderTotal: 2000,
      shipping: 0,
      discount: 0,
    },
    {
      name: "two-way odd cents",
      totals: [1033, 967],
      orderTotal: 2000,
      shipping: 0,
      discount: 0,
    },
    {
      name: "three-way split",
      totals: [333, 333, 334],
      orderTotal: 1000,
      shipping: 0,
      discount: 0,
    },
    {
      name: "three-way with shipping and discount",
      totals: [1234, 5678, 9012],
      orderTotal: 1234 + 5678 + 9012 + 499 - 250,
      shipping: 499,
      discount: 250,
    },
    {
      name: "a total that does not match the parts at all",
      totals: [1000, 1000],
      orderTotal: 2007,
      shipping: 0,
      discount: 0,
    },
    {
      name: "a discount larger than the primary's lines",
      totals: [100, 5000],
      orderTotal: 100 + 5000 - 600,
      shipping: 0,
      discount: 600,
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const shares = splitOrderMoney({
        perSource: testCase.totals.map((lineTotalMinor, index) =>
          part({
            sourceId: `s${index}`,
            sourceCode: `S${index}`,
            lineTotalMinor,
          }),
        ),
        orderTotalMinor: testCase.orderTotal,
        shippingMinor: testCase.shipping,
        discountMinor: testCase.discount,
      });

      expect(sum(shares)).toBe(testCase.orderTotal);
      expect(shares.filter((s) => s.isPrimary)).toHaveLength(1);
      for (const share of shares) {
        expect(Number.isInteger(share.totalMinor)).toBe(true);
      }
    });
  }

  it("returns nothing when there are no sources", () => {
    expect(
      splitOrderMoney({
        perSource: [],
        orderTotalMinor: 1000,
        shippingMinor: 0,
        discountMinor: 0,
      }),
    ).toEqual([]);
  });
});

/*
 * A sales order worth less than nothing. MetaKocka would file it without a word,
 * because it validates almost nothing (§3).
 *
 * Spreading the discount by merchandise value removes the *ordinary* way this
 * used to happen: when the whole discount sat on the primary document, a
 * discount larger than that one document's lines produced a negative beside a
 * positive, on a perfectly normal order. A proportional share can never exceed
 * the merchandise it is proportional to, so that case is now arithmetically
 * impossible — see the test below it.
 *
 * What remains is the genuinely strange order: a discount larger than
 * everything the customer bought. That still goes negative, and it still has to
 * be refused rather than filed.
 */
describe("a document that would go negative", () => {
  const shares = splitOrderMoney({
    perSource: [
      part({ sourceId: "a", sourceCode: "A", lineTotalMinor: 5000 }),
      part({
        sourceId: "b",
        sourceCode: "B",
        kind: "partner",
        lineTotalMinor: 3000,
      }),
    ],
    // 90.00 off an order whose goods come to 80.00.
    orderTotalMinor: -1000,
    shippingMinor: 0,
    discountMinor: 9000,
  });

  it("still adds up, which is exactly why nothing downstream notices", () => {
    expect(sum(shares)).toBe(-1000);
  });

  it("is reported rather than sent", () => {
    const negative = negativeShares(shares);
    expect(negative.length).toBeGreaterThan(0);
    expect(negative.every((share) => share.totalMinor < 0)).toBe(true);
  });

  it("no longer goes negative on an ordinary over-discounted primary", () => {
    /*
     * The case that used to fail: an 80.00 discount on a 50/30 split. Under the
     * old primary-only rule the primary went to -30.00; spread by value each
     * document simply reaches zero.
     */
    const ordinary = splitOrderMoney({
      perSource: [
        part({ sourceId: "a", sourceCode: "A", lineTotalMinor: 5000 }),
        part({ sourceId: "b", sourceCode: "B", lineTotalMinor: 3000 }),
      ],
      orderTotalMinor: 0,
      shippingMinor: 0,
      discountMinor: 8000,
    });

    expect(negativeShares(ordinary)).toEqual([]);
    expect(sum(ordinary)).toBe(0);
  });

  it("says nothing about an ordinary split", () => {
    const ordinary = splitOrderMoney({
      perSource: [
        part({ sourceId: "a", sourceCode: "A", lineTotalMinor: 5000 }),
        part({ sourceId: "b", sourceCode: "B", lineTotalMinor: 3000 }),
      ],
      orderTotalMinor: 8499,
      shippingMinor: 499,
      discountMinor: 0,
    });

    expect(negativeShares(ordinary)).toEqual([]);
  });
});

describe("proportionalSplit", () => {
  it("always adds back up to the amount", () => {
    const cases: [number, number[]][] = [
      [1000, [1, 1, 1]],
      [100, [1, 2, 3]],
      [1, [1, 1]],
      [999, [333, 333, 333]],
      [12345, [7, 11, 13, 17]],
    ];

    for (const [amount, weights] of cases) {
      const parts = proportionalSplit(amount, weights);
      expect(parts.reduce((total, value) => total + value, 0)).toBe(amount);
      expect(parts.every(Number.isInteger)).toBe(true);
    }
  });

  it("gives every part zero when the weights are empty", () => {
    expect(proportionalSplit(500, [0, 0])).toEqual([0, 0]);
  });
});
