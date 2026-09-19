import { afterEach, expect, it } from "vitest";

import {
  getAttributeSchema,
  saveAttributeSchema,
} from "~/adapters/db/repositories/attribute-schema.server";
import { starterSchema } from "~/domain/attributes/starter";
import { emptySchema } from "~/domain/attributes/types";

import {
  createTenant,
  describeDatabase,
  destroyTenant,
  type TestTenant,
} from "./harness";

/**
 * The attribute schema row, against a real database (docs/attributes.md
 * § Persistence): a shop with nothing stored reads as empty at revision 0,
 * the first write creates the row, every write is conditional on the
 * revision it was made against, and the loser of a race is told so rather
 * than quietly winning.
 */
describeDatabase("attribute schema persistence", () => {
  let tenant: TestTenant | null = null;

  afterEach(async () => {
    if (tenant) await destroyTenant(tenant);
    tenant = null;
  });

  it("reads empty before anything is stored and round-trips a document", async () => {
    tenant = await createTenant("attr-roundtrip");

    const before = await getAttributeSchema(tenant.principal);
    expect(before).toEqual({
      schema: emptySchema(),
      revision: 0,
      updatedAt: null,
    });

    const saved = await saveAttributeSchema(
      tenant.principal,
      starterSchema(),
      0,
    );
    expect(saved).toEqual({ ok: true, revision: 1 });

    const after = await getAttributeSchema(tenant.principal);
    expect(after.revision).toBe(1);
    expect(after.schema).toEqual(starterSchema());
    expect(after.updatedAt).not.toBeNull();
  });

  it("refuses a write made against a revision that has moved on", async () => {
    tenant = await createTenant("attr-conflict");
    await saveAttributeSchema(tenant.principal, starterSchema(), 0);

    // Two people read revision 1; the first to save wins.
    const first = await saveAttributeSchema(tenant.principal, emptySchema(), 1);
    expect(first).toEqual({ ok: true, revision: 2 });
    const second = await saveAttributeSchema(
      tenant.principal,
      starterSchema(),
      1,
    );
    expect(second).toEqual({ ok: false, reason: "conflict" });

    const stored = await getAttributeSchema(tenant.principal);
    expect(stored.revision).toBe(2);
    expect(stored.schema).toEqual(emptySchema());

    // A second "first write" is a conflict too, not a second row.
    expect(
      await saveAttributeSchema(tenant.principal, starterSchema(), 0),
    ).toEqual({
      ok: false,
      reason: "conflict",
    });
  });
});
