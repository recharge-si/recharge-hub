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
  it("puts shipping on the primary document only", () => {
    const shares = splitOrderMoney({
      perSource: [
        part({ sourceId: "a", sourceCode: "A", lineTotalMinor: 3000 }),
        part({ sourceId: "b", sourceCode: "B", lineTotalMinor: 1000 }),
      ],
      orderTotalMinor: 4500,
      shippingMinor: 500,
      discountMinor: 0,
    });

    const primary = shares.find((s) => s.isPrimary)!;
    const other = shares.find((s) => !s.isPrimary)!;

    expect(primary.shippingMinor).toBe(500);
    expect(other.shippingMinor).toBe(0);
    expect(sum(shares)).toBe(4500);
  });

  it("puts an order-level discount on the primary document only", () => {
    const shares = splitOrderMoney({
      perSource: [
        part({ sourceId: "a", sourceCode: "A", lineTotalMinor: 3000 }),
        part({ sourceId: "b", sourceCode: "B", lineTotalMinor: 1000 }),
      ],
      orderTotalMinor: 3600,
      shippingMinor: 0,
      discountMinor: 400,
    });

    const primary = shares.find((s) => s.isPrimary)!;
    expect(primary.discountMinor).toBe(400);
    expect(primary.totalMinor).toBe(2600);
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
 * §8.6 puts the order-level discount on the primary document alone. On a split
 * order where that discount is bigger than the primary's own lines, obeying
 * the rule produces a sales order worth less than nothing — and MetaKocka
 * would file it without a word, because it validates almost nothing (§3).
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
    orderTotalMinor: 0,
    shippingMinor: 0,
    discountMinor: 8000,
  });

  it("still adds up, which is exactly why nothing downstream notices", () => {
    expect(sum(shares)).toBe(0);
  });

  it("is reported rather than sent", () => {
    const negative = negativeShares(shares);
    expect(negative).toHaveLength(1);
    expect(negative[0]?.sourceCode).toBe("A");
    expect(negative[0]?.isPrimary).toBe(true);
    expect(negative[0]!.totalMinor).toBeLessThan(0);
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
