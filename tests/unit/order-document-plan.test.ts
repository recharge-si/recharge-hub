import { describe, expect, it } from "vitest";

import {
  planDocuments,
  retirementPlanFor,
  sameLines,
  type DesiredDocument,
  type DocumentAction,
  type ExistingDocument,
} from "~/domain/orders/reconcile";

/**
 * The reconciliation diff (brief §3–§9).
 *
 * Every scenario in the brief's list is here, and each asserts the same two
 * things: the *right* change is planned, and **no second document is created**.
 * That second half is the one that matters. A connector that creates a document
 * because an event arrived produces a correct answer for the first webhook and
 * a duplicate for every one after it; a connector that plans from desired state
 * cannot, because "this warehouse has no document" stops being true after the
 * first pass.
 */

function existing(
  input: Partial<ExistingDocument> & { supplySourceId: string },
): ExistingDocument {
  return {
    documentId: `doc-${input.supplySourceId}`,
    countCode: `SH-1050-${input.supplySourceId.toUpperCase()}`,
    status: "written",
    present: true,
    paid: false,
    retired: false,
    lines: [],
    ...input,
  };
}

function desired(
  supplySourceId: string,
  lines: { sku: string; quantity: number }[],
): DesiredDocument {
  return { supplySourceId, lines };
}

const kinds = (actions: DocumentAction[]) =>
  actions.map((action) =>
    action.kind === "retire"
      ? `retire:${action.countCode}`
      : `${action.kind}:${action.supplySourceId}`,
  );

const creates = (actions: DocumentAction[]) =>
  actions.filter((action) => action.kind === "create");

/* -------------------------------------------------------------------------- */

describe("an order arriving for the first time", () => {
  it("plans one document per warehouse and nothing else", () => {
    const actions = planDocuments({
      desired: [
        desired("a", [
          { sku: "SKU-A", quantity: 2 },
          { sku: "SKU-B", quantity: 1 },
        ]),
        desired("b", [{ sku: "SKU-C", quantity: 3 }]),
      ],
      existing: [],
    });

    expect(kinds(actions)).toEqual(["create:a", "create:b"]);
  });
});

describe("a duplicate webhook, and reconciling an unchanged order (§3)", () => {
  it("plans nothing at all the second time", () => {
    /*
     * The brief's requirement, verbatim: repeated reconciliation of an
     * unchanged Shopify order must result in 0 new documents and 0 duplicated
     * quantities.
     */
    const lines = [{ sku: "SKU-A", quantity: 2 }];

    const actions = planDocuments({
      desired: [desired("a", lines)],
      existing: [existing({ supplySourceId: "a", lines })],
    });

    expect(kinds(actions)).toEqual(["unchanged:a"]);
    expect(creates(actions)).toHaveLength(0);
  });

  it("stays at zero new documents however many times it runs", () => {
    const lines = [{ sku: "SKU-A", quantity: 2 }];
    const state = [existing({ supplySourceId: "a", lines })];

    for (let pass = 0; pass < 10; pass += 1) {
      const actions = planDocuments({
        desired: [desired("a", lines)],
        existing: state,
      });
      expect(creates(actions)).toHaveLength(0);
    }
  });
});

describe("an order edited in Shopify (§4, §5, §6)", () => {
  it("adds a product to the existing document rather than writing a second", () => {
    const actions = planDocuments({
      desired: [
        desired("a", [
          { sku: "SKU-A", quantity: 1 },
          { sku: "SKU-B", quantity: 2 },
        ]),
      ],
      existing: [
        existing({ supplySourceId: "a", lines: [{ sku: "SKU-A", quantity: 1 }] }),
      ],
    });

    expect(kinds(actions)).toEqual(["update:a"]);
    expect(creates(actions)).toHaveLength(0);
  });

  it("updates a quantity in place", () => {
    const actions = planDocuments({
      desired: [desired("a", [{ sku: "SKU-A", quantity: 5 }])],
      existing: [
        existing({ supplySourceId: "a", lines: [{ sku: "SKU-A", quantity: 2 }] }),
      ],
    });

    expect(kinds(actions)).toEqual(["update:a"]);
  });

  it("updates when a line is removed", () => {
    const actions = planDocuments({
      desired: [desired("a", [{ sku: "SKU-A", quantity: 2 }])],
      existing: [
        existing({
          supplySourceId: "a",
          lines: [
            { sku: "SKU-A", quantity: 2 },
            { sku: "SKU-B", quantity: 1 },
          ],
        }),
      ],
    });

    expect(kinds(actions)).toEqual(["update:a"]);
  });
});

describe("a line moving between locations (§7)", () => {
  it("moves the quantity: the old document is retired, the new one created", () => {
    /*
     * The forbidden outcome named in the brief is MK-A holding SKU-A ×2 *and*
     * MK-B holding SKU-A ×2. The plan makes that impossible: A is not in the
     * desired set, so it is retired rather than left alone.
     */
    const actions = planDocuments({
      desired: [desired("b", [{ sku: "SKU-A", quantity: 2 }])],
      existing: [
        existing({ supplySourceId: "a", lines: [{ sku: "SKU-A", quantity: 2 }] }),
      ],
    });

    expect(kinds(actions)).toEqual(["create:b", "retire:SH-1050-A"]);
  });

  it("moves it back into the same document rather than making a third", () => {
    // A line that went to B and came back. The row for A is still there,
    // retired; reviving it is what keeps the count_code claim doing its job.
    const actions = planDocuments({
      desired: [desired("a", [{ sku: "SKU-A", quantity: 2 }])],
      existing: [
        existing({
          supplySourceId: "a",
          retired: true,
          lines: [{ sku: "SKU-A", quantity: 2 }],
        }),
        existing({ supplySourceId: "b", lines: [{ sku: "SKU-A", quantity: 2 }] }),
      ],
    });

    // A is updated (revived), B is retired. Nothing is created.
    expect(kinds(actions)).toEqual(["update:a", "retire:SH-1050-B"]);
    expect(creates(actions)).toHaveLength(0);
  });
});

describe("a partial move between locations (§8)", () => {
  it("leaves 2 on A and puts 3 on B, and no quantity anywhere else", () => {
    const actions = planDocuments({
      desired: [
        desired("a", [{ sku: "SKU-A", quantity: 2 }]),
        desired("b", [{ sku: "SKU-A", quantity: 3 }]),
      ],
      existing: [
        existing({ supplySourceId: "a", lines: [{ sku: "SKU-A", quantity: 5 }] }),
      ],
    });

    expect(kinds(actions)).toEqual(["update:a", "create:b"]);
    // Exactly one new document, for the warehouse that had none.
    expect(creates(actions)).toHaveLength(1);
  });
});

describe("splitting and merging (§9)", () => {
  it("reuses the existing document on a split and creates only the new one", () => {
    const actions = planDocuments({
      desired: [
        desired("a", [{ sku: "SKU-A", quantity: 1 }]),
        desired("b", [{ sku: "SKU-B", quantity: 1 }]),
      ],
      existing: [
        existing({
          supplySourceId: "a",
          lines: [
            { sku: "SKU-A", quantity: 1 },
            { sku: "SKU-B", quantity: 1 },
          ],
        }),
      ],
    });

    expect(kinds(actions)).toEqual(["update:a", "create:b"]);
  });

  it("on a merge, fills the surviving document and retires the other", () => {
    const actions = planDocuments({
      desired: [
        desired("a", [
          { sku: "SKU-A", quantity: 1 },
          { sku: "SKU-B", quantity: 1 },
        ]),
      ],
      existing: [
        existing({ supplySourceId: "a", lines: [{ sku: "SKU-A", quantity: 1 }] }),
        existing({ supplySourceId: "b", lines: [{ sku: "SKU-B", quantity: 1 }] }),
      ],
    });

    expect(kinds(actions)).toEqual(["update:a", "retire:SH-1050-B"]);
    expect(creates(actions)).toHaveLength(0);
  });
});

describe("a document that is not really there", () => {
  it("treats a failed row as a create, keeping its id so the claim is reused", () => {
    /*
     * The claim on `(shop, count_code)` lives on that row. Losing it here would
     * invite the write path to claim a second code for the same warehouse,
     * which is exactly the duplicate §8.4 exists to prevent.
     */
    const actions = planDocuments({
      desired: [desired("a", [{ sku: "SKU-A", quantity: 1 }])],
      existing: [
        existing({ supplySourceId: "a", status: "failed", present: false }),
      ],
    });

    expect(actions).toEqual([
      { kind: "create", supplySourceId: "a", documentId: "doc-a" },
    ]);
  });

  it("treats a pending row with no MetaKocka id the same way", () => {
    const actions = planDocuments({
      desired: [desired("a", [{ sku: "SKU-A", quantity: 1 }])],
      existing: [
        existing({ supplySourceId: "a", status: "pending", present: false }),
      ],
    });

    expect(kinds(actions)).toEqual(["create:a"]);
  });
});

describe("comparing lines", () => {
  it("ignores order and merges repeats", () => {
    expect(
      sameLines(
        [
          { sku: "B", quantity: 1 },
          { sku: "A", quantity: 2 },
        ],
        [
          { sku: "A", quantity: 1 },
          { sku: "A", quantity: 1 },
          { sku: "B", quantity: 1 },
        ],
      ),
    ).toBe(true);
  });

  it("ignores zero-quantity lines", () => {
    expect(
      sameLines([{ sku: "A", quantity: 2 }], [
        { sku: "A", quantity: 2 },
        { sku: "B", quantity: 0 },
      ]),
    ).toBe(true);
  });

  it("notices a quantity difference", () => {
    expect(
      sameLines([{ sku: "A", quantity: 2 }], [{ sku: "A", quantity: 3 }]),
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe("what happens to an obsolete document", () => {
  const retire = (
    overrides: Partial<Extract<DocumentAction, { kind: "retire" }>> = {},
  ): Extract<DocumentAction, { kind: "retire" }> => ({
    kind: "retire",
    supplySourceId: "a",
    documentId: "doc-a",
    countCode: "SH-1050-A",
    paid: false,
    present: true,
    ...overrides,
  });

  it("empties it by default, so no stale quantity is left behind", () => {
    expect(retirementPlanFor(retire(), "empty").kind).toBe("empty");
  });

  it("leaves it exactly as it is under the cautious setting", () => {
    expect(retirementPlanFor(retire(), "report").kind).toBe("report");
  });

  it("deletes an unpaid one only when the merchant asked for that", () => {
    expect(retirementPlanFor(retire(), "delete_unpaid").kind).toBe("delete");
  });

  it("never deletes a paid one, even under the delete setting", () => {
    /*
     * §8.8's rule with the one opt-in carved out of it. A payment is the
     * strongest available signal that a document has been through the
     * merchant's books, and the setting says delete the *unpaid* ones.
     */
    const plan = retirementPlanFor(retire({ paid: true }), "delete_unpaid");
    expect(plan.kind).toBe("empty");
    expect(plan.reason).toContain("payment");
  });

  it("just drops a row nothing was ever written for", () => {
    // No MetaKocka call, no exception: there is nothing there to be wrong.
    for (const policy of ["report", "empty", "delete_unpaid"] as const) {
      expect(retirementPlanFor(retire({ present: false }), policy).kind).toBe(
        "discard",
      );
    }
  });
});
