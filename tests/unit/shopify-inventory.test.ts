import { describe, expect, it, vi } from "vitest";

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import {
  InventoryLocationMismatchError,
  InventoryOwnershipError,
  activateOnHand,
  writeOnHand,
} from "~/adapters/shopify/inventory";

/**
 * CLAUDE.md §7: one writer per location, enforced in the adapter as a throw.
 * These tests exist so the throw cannot quietly become an early return — the
 * difference between "the write did not happen and everyone knows" and "the
 * write did not happen and the job reported success".
 */

function fakeAdmin(result: unknown) {
  const graphql = vi.fn(async () =>
    new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  return {
    admin: { graphql } as unknown as AdminApiContext,
    graphql,
  };
}

const WRITE = {
  inventoryItemId: "gid://shopify/InventoryItem/1",
  locationId: "gid://shopify/Location/1",
  quantity: 5,
  changeFromQuantity: 3,
};

const OK_SET_RESULT = {
  data: { inventorySetQuantities: { userErrors: [] } },
};

describe("one writer per location (§7)", () => {
  it("writeOnHand throws for an externally-owned location and never calls Shopify", async () => {
    const { admin, graphql } = fakeAdmin(OK_SET_RESULT);

    await expect(
      writeOnHand(admin, [WRITE], {
        inventoryWriter: "external",
        locationId: WRITE.locationId,
        runId: "job-1",
      }),
    ).rejects.toBeInstanceOf(InventoryOwnershipError);

    expect(graphql).not.toHaveBeenCalled();
  });

  it("writeOnHand throws for a manually-owned location even with nothing to write", async () => {
    // The guard runs before the empty-batch early return: ownership is about
    // who may hold the pen, not about whether there is ink in it today.
    const { admin, graphql } = fakeAdmin(OK_SET_RESULT);

    await expect(
      writeOnHand(admin, [], {
        inventoryWriter: "manual",
        locationId: WRITE.locationId,
        runId: "job-1",
      }),
    ).rejects.toBeInstanceOf(InventoryOwnershipError);

    expect(graphql).not.toHaveBeenCalled();
  });

  it("activateOnHand enforces the same ownership rule — activating is a write", async () => {
    const { admin, graphql } = fakeAdmin({ data: {} });

    await expect(
      activateOnHand(
        admin,
        [
          {
            inventoryItemId: WRITE.inventoryItemId,
            locationId: WRITE.locationId,
            quantity: 5,
          },
        ],
        {
          inventoryWriter: "external",
          locationId: WRITE.locationId,
          runId: "job-1",
        },
      ),
    ).rejects.toBeInstanceOf(InventoryOwnershipError);

    expect(graphql).not.toHaveBeenCalled();
  });

  it("writeOnHand writes for the metakocka-owned location, with the idempotency key and the compare quantity", async () => {
    const { admin, graphql } = fakeAdmin(OK_SET_RESULT);

    await writeOnHand(admin, [WRITE], {
      inventoryWriter: "metakocka",
      locationId: WRITE.locationId,
      runId: "job-1",
    });

    expect(graphql).toHaveBeenCalledTimes(1);
    const [, options] = graphql.mock.calls[0]! as unknown as [
      string,
      { variables: { key: string; input: Record<string, unknown> } },
    ];
    expect(options.variables.key).toMatch(/^[0-9a-f]{64}$/);
    expect(options.variables.input).toMatchObject({
      name: "on_hand",
      quantities: [
        {
          inventoryItemId: WRITE.inventoryItemId,
          quantity: 5,
          changeFromQuantity: 3,
        },
      ],
    });
  });

  it("derives the same idempotency key for a retry and a fresh key for changed numbers", async () => {
    // A retry re-sending identical numbers must be recognised as one write; a
    // retry that re-read different numbers must not be swallowed by the cached
    // result of the first (§7).
    const keys: string[] = [];
    const graphql = vi.fn(
      async (_query: string, options: { variables: { key: string } }) => {
        keys.push(options.variables.key);
        return new Response(JSON.stringify(OK_SET_RESULT), { status: 200 });
      },
    );
    const admin = { graphql } as unknown as AdminApiContext;

    const options = {
      inventoryWriter: "metakocka",
      locationId: WRITE.locationId,
      runId: "job-1",
    };

    await writeOnHand(admin, [WRITE], options);
    await writeOnHand(admin, [WRITE], options);
    await writeOnHand(admin, [{ ...WRITE, quantity: 6 }], options);
    await writeOnHand(admin, [WRITE], { ...options, runId: "job-2" });

    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[3]).not.toBe(keys[0]);
  });
});

/*
 * The ownership check reads `options.locationId` once while each item names
 * its own, so a batch that mixed locations would write every item on the
 * strength of a check that covered only one of them — the partner or manual
 * location §7 says never to write.
 */
describe("a batch that mixes locations", () => {
  const OTHER = "gid://shopify/Location/999";

  it("writeOnHand refuses it and never calls Shopify", async () => {
    const { admin, graphql } = fakeAdmin(OK_SET_RESULT);

    await expect(
      writeOnHand(admin, [WRITE, { ...WRITE, locationId: OTHER }], {
        inventoryWriter: "metakocka",
        locationId: WRITE.locationId,
        runId: "job-1",
      }),
    ).rejects.toBeInstanceOf(InventoryLocationMismatchError);

    expect(graphql).not.toHaveBeenCalled();
  });

  it("activateOnHand refuses it, because it stocks every item at the checked location", async () => {
    const { admin, graphql } = fakeAdmin({ data: {} });

    await expect(
      activateOnHand(
        admin,
        [
          {
            inventoryItemId: WRITE.inventoryItemId,
            locationId: OTHER,
            quantity: 1,
          },
        ],
        {
          inventoryWriter: "metakocka",
          locationId: WRITE.locationId,
          runId: "job-1",
        },
      ),
    ).rejects.toBeInstanceOf(InventoryLocationMismatchError);

    expect(graphql).not.toHaveBeenCalled();
  });
});
