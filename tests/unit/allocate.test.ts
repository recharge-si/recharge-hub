import { describe, expect, it } from "vitest";

import { allocate } from "~/domain/allocation/allocate";
import {
  DEFAULT_RULE,
  type AllocationLine,
  type SupplyLevel,
} from "~/domain/allocation/types";

/**
 * CLAUDE.md section 12 names the cases this has to cover, and they are all
 * here: zero stock, exact stock, partial stock, split disabled, same SKU on two
 * lines, zero quantity, source disabled, priority ties.
 *
 * The clock is injected and fixed. Nothing in the allocator may read the real
 * one (section 5), and a frozen date is how that stays true.
 */
const NOW = new Date("2026-08-25T00:00:00.000Z");

function source(over: Partial<SupplyLevel> = {}): SupplyLevel {
  return {
    sourceId: "own-1",
    sourceCode: "OWN",
    sku: "SKU-1",
    available: 10,
    kind: "own",
    priority: 100,
    canSplit: true,
    enabled: true,
    ...over,
  };
}

function line(over: Partial<AllocationLine> = {}): AllocationLine {
  return { lineId: "line-1", sku: "SKU-1", quantity: 1, ...over };
}

const run = (lines: AllocationLine[], supply: SupplyLevel[]) =>
  allocate({ lines, supply, rules: [DEFAULT_RULE], now: NOW });

describe("filling a line", () => {
  it("takes everything from one source when it has enough", () => {
    const { allocations, shortfalls } = run(
      [line({ quantity: 3 })],
      [source({ available: 10 })],
    );

    expect(shortfalls).toEqual([]);
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({ sourceId: "own-1", quantity: 3 });
  });

  it("takes exactly the stock there is", () => {
    const { allocations, shortfalls } = run(
      [line({ quantity: 5 })],
      [source({ available: 5 })],
    );

    expect(shortfalls).toEqual([]);
    expect(allocations[0]?.quantity).toBe(5);
  });

  it("with no stock anywhere, the whole line waits for a human", () => {
    const { allocations, shortfalls } = run(
      [line({ quantity: 2 })],
      [source({ available: 0 })],
    );

    expect(shortfalls).toEqual([
      { lineId: "line-1", sku: "SKU-1", quantity: 2 },
    ]);
    expect(allocations[0]?.sourceId).toBeNull();
  });

  it("with no source at all, the whole line waits for a human", () => {
    const { shortfalls } = run([line({ quantity: 2 })], []);
    expect(shortfalls[0]?.quantity).toBe(2);
  });
});

describe("the demo case from section 13", () => {
  it("splits 8 across own 5 and partner 3", () => {
    const { allocations, shortfalls } = run(
      [line({ quantity: 8 })],
      [
        source({ sourceId: "own-1", sourceCode: "OWN", available: 5 }),
        source({
          sourceId: "partner-1",
          sourceCode: "PARTNER",
          available: 20,
          kind: "partner",
        }),
      ],
    );

    expect(shortfalls).toEqual([]);
    expect(allocations.map((a) => [a.sourceId, a.quantity])).toEqual([
      ["own-1", 5],
      ["partner-1", 3],
    ]);
    // The audit trail has to explain it, not just record it.
    expect(allocations[1]?.reason.detail).toContain("covered 3 of 3");
  });

  it("allocates what it can and leaves the rest as a shortfall", () => {
    const { allocations, shortfalls } = run(
      [line({ quantity: 8 })],
      [source({ available: 5 })],
    );

    expect(allocations[0]).toMatchObject({ sourceId: "own-1", quantity: 5 });
    expect(allocations[1]).toMatchObject({ sourceId: null, quantity: 3 });
    expect(shortfalls).toEqual([
      { lineId: "line-1", sku: "SKU-1", quantity: 3 },
    ]);
  });
});

describe("ordering", () => {
  it("prefers own stock over a partner at the same priority", () => {
    const { allocations } = run(
      [line({ quantity: 2 })],
      [
        source({
          sourceId: "partner-1",
          sourceCode: "AAA",
          kind: "partner",
          available: 10,
        }),
        source({ sourceId: "own-1", sourceCode: "ZZZ", available: 10 }),
      ],
    );

    expect(allocations[0]?.sourceId).toBe("own-1");
  });

  it("respects priority ahead of kind", () => {
    const { allocations } = run(
      [line({ quantity: 2 })],
      [
        source({
          sourceId: "partner-1",
          kind: "partner",
          priority: 1,
          available: 10,
        }),
        source({ sourceId: "own-1", priority: 50, available: 10 }),
      ],
    );

    expect(allocations[0]?.sourceId).toBe("partner-1");
  });

  it("breaks a full tie by source code, so a retry decides the same way", () => {
    const supply = [
      source({ sourceId: "b", sourceCode: "BBB", available: 10 }),
      source({ sourceId: "a", sourceCode: "AAA", available: 10 }),
    ];

    const first = run([line({ quantity: 1 })], supply);
    const second = run([line({ quantity: 1 })], [...supply].reverse());

    expect(first.allocations[0]?.sourceId).toBe("a");
    expect(second.allocations[0]?.sourceId).toBe("a");
  });
});

describe("splitting", () => {
  it("will not split a line across a source that refuses partial orders", () => {
    const { allocations, shortfalls } = run(
      [line({ quantity: 8 })],
      [
        source({ sourceId: "own-1", available: 5 }),
        source({
          sourceId: "partner-1",
          sourceCode: "PARTNER",
          kind: "partner",
          available: 20,
          canSplit: false,
        }),
      ],
    );

    // Own covers 5; the partner will not take the remaining 3 on its own terms.
    expect(allocations[0]).toMatchObject({ sourceId: "own-1", quantity: 5 });
    expect(shortfalls[0]?.quantity).toBe(3);
  });

  it("uses a no-split source when it can cover the whole line", () => {
    const { allocations, shortfalls } = run(
      [line({ quantity: 4 })],
      [source({ canSplit: false, available: 10 })],
    );

    expect(shortfalls).toEqual([]);
    expect(allocations[0]?.quantity).toBe(4);
  });

  it("with splitting forbidden, sends the whole line to one source that can cover it", () => {
    const result = allocate({
      lines: [line({ quantity: 8 })],
      supply: [
        source({ sourceId: "own-1", available: 5 }),
        source({
          sourceId: "partner-1",
          sourceCode: "PARTNER",
          kind: "partner",
          available: 20,
        }),
      ],
      rules: [{ ...DEFAULT_RULE, allowSplit: false }],
      now: NOW,
    });

    // Own is preferred but cannot cover 8 on its own, and splitting is off, so
    // it is passed over entirely rather than part-filled.
    expect(result.shortfalls).toEqual([]);
    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]).toMatchObject({
      sourceId: "partner-1",
      quantity: 8,
    });
  });

  it("with splitting forbidden and nobody able to cover it, nothing is allocated", () => {
    const result = allocate({
      lines: [line({ quantity: 8 })],
      supply: [
        source({ sourceId: "own-1", available: 5 }),
        source({
          sourceId: "partner-1",
          sourceCode: "PARTNER",
          kind: "partner",
          available: 6,
        }),
      ],
      rules: [{ ...DEFAULT_RULE, allowSplit: false }],
      now: NOW,
    });

    expect(result.shortfalls[0]?.quantity).toBe(8);
    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]?.sourceId).toBeNull();
  });
});

describe("stock is consumed across the whole order", () => {
  it("does not promise the same unit to two lines of the same SKU", () => {
    const { allocations, shortfalls } = run(
      [
        line({ lineId: "line-1", quantity: 4 }),
        line({ lineId: "line-2", quantity: 4 }),
      ],
      [source({ available: 6 })],
    );

    const fromOwn = allocations
      .filter((a) => a.sourceId === "own-1")
      .reduce((sum, a) => sum + a.quantity, 0);

    expect(fromOwn).toBe(6);
    expect(shortfalls).toEqual([
      { lineId: "line-2", sku: "SKU-1", quantity: 2 },
    ]);
  });

  it("keeps different SKUs independent", () => {
    const { shortfalls } = run(
      [
        line({ lineId: "line-1", sku: "SKU-1", quantity: 5 }),
        line({ lineId: "line-2", sku: "SKU-2", quantity: 5 }),
      ],
      [
        source({ sku: "SKU-1", available: 5 }),
        source({ sourceId: "own-1", sku: "SKU-2", available: 5 }),
      ],
    );

    expect(shortfalls).toEqual([]);
  });
});

describe("edge cases", () => {
  it("ignores a line with zero quantity", () => {
    const { allocations, shortfalls } = run(
      [line({ quantity: 0 })],
      [source()],
    );
    expect(allocations).toEqual([]);
    expect(shortfalls).toEqual([]);
  });

  it("ignores a negative quantity rather than crediting stock", () => {
    const { allocations, shortfalls } = run(
      [line({ quantity: -3 })],
      [source()],
    );
    expect(allocations).toEqual([]);
    expect(shortfalls).toEqual([]);
  });

  it("skips a disabled source entirely", () => {
    const { shortfalls } = run(
      [line({ quantity: 2 })],
      [source({ enabled: false, available: 99 })],
    );
    expect(shortfalls[0]?.quantity).toBe(2);
  });

  it("treats negative stock as none", () => {
    const { shortfalls } = run(
      [line({ quantity: 2 })],
      [source({ available: -5 })],
    );
    expect(shortfalls[0]?.quantity).toBe(2);
  });

  it("never allocates more than was ordered", () => {
    const { allocations } = run(
      [line({ quantity: 2 })],
      [
        source({ sourceId: "a", sourceCode: "A", available: 10 }),
        source({ sourceId: "b", sourceCode: "B", available: 10 }),
      ],
    );

    const total = allocations.reduce((sum, a) => sum + a.quantity, 0);
    expect(total).toBe(2);
  });

  it("is a pure function of its input", () => {
    const lines = [line({ quantity: 3 })];
    const supply = [source({ available: 10 })];
    const before = JSON.stringify({ lines, supply });

    const first = run(lines, supply);
    const second = run(lines, supply);

    expect(JSON.stringify({ lines, supply })).toBe(before);
    expect(first).toEqual(second);
  });
});
