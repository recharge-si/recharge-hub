import { Prisma } from "@prisma/client";

import { prisma } from "~/adapters/db/client.server";
import { parseAttributeSchema } from "~/domain/attributes/schema";
import { emptySchema, type AttributeSchema } from "~/domain/attributes/types";
import { shopDomainOf, type Principal } from "~/domain/types";

/**
 * The shop's attribute schema, one document per shop (docs/attributes.md
 * § Persistence).
 *
 * `revision` is the concurrency boundary. A read hands back the revision
 * with the document; a write says which revision it was made against and is
 * a conditional update, so the second of two people saving over the same
 * revision is told to reload rather than quietly winning. Revision 0 means
 * no row yet, and the first write creates it.
 */

export interface StoredSchema {
  schema: AttributeSchema;
  revision: number;
  updatedAt: Date | null;
}

async function shopIdFor(principal: Principal): Promise<string> {
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomainOf(principal) },
    select: { id: true },
  });
  if (!shop) throw new Error(`Unknown shop ${shopDomainOf(principal)}`);
  return shop.id;
}

export async function getAttributeSchema(
  principal: Principal,
): Promise<StoredSchema> {
  const row = await prisma.attributeSchema.findFirst({
    where: { shop: { domain: shopDomainOf(principal) } },
    select: { document: true, revision: true, updatedAt: true },
  });
  if (!row) return { schema: emptySchema(), revision: 0, updatedAt: null };

  const parsed = parseAttributeSchema(row.document);
  if (!parsed.ok) {
    // Every write is validated first, so this is corruption, not input.
    throw new Error(
      `Stored attribute schema for ${shopDomainOf(principal)} is unreadable: ${parsed.message}`,
    );
  }
  return {
    schema: parsed.schema,
    revision: row.revision,
    updatedAt: row.updatedAt,
  };
}

export type SaveOutcome =
  { ok: true; revision: number } | { ok: false; reason: "conflict" };

/**
 * Writes the document if nobody has since the caller read it.
 *
 * The document is round-tripped through the parser rather than trusted: a
 * caller that assembled it by hand cannot store something a later read would
 * refuse.
 */
export async function saveAttributeSchema(
  principal: Principal,
  schema: AttributeSchema,
  expectedRevision: number,
): Promise<SaveOutcome> {
  const parsed = parseAttributeSchema(schema);
  if (!parsed.ok)
    throw new Error(`Refusing to store an invalid schema: ${parsed.message}`);
  const document = parsed.schema as unknown as Prisma.InputJsonValue;
  const shopId = await shopIdFor(principal);

  if (expectedRevision === 0) {
    try {
      const created = await prisma.attributeSchema.create({
        data: { shopId, document, revision: 1 },
        select: { revision: true },
      });
      return { ok: true, revision: created.revision };
    } catch (error) {
      // The unique index on shop_id: somebody created the row first.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        return { ok: false, reason: "conflict" };
      throw error;
    }
  }

  const updated = await prisma.attributeSchema.updateMany({
    where: { shopId, revision: expectedRevision },
    data: { document, revision: expectedRevision + 1 },
  });
  return updated.count === 1
    ? { ok: true, revision: expectedRevision + 1 }
    : { ok: false, reason: "conflict" };
}
