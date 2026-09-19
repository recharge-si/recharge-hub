import { randomBytes } from "node:crypto";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  getAttributeSchema,
  saveAttributeSchema,
} from "~/adapters/db/repositories/attribute-schema.server";
import type { MutationResult } from "~/domain/attributes/mutations";
import { schemaProblems } from "~/domain/attributes/schema";
import type { AttributeSchema, IdSource } from "~/domain/attributes/types";
import type { Principal } from "~/domain/types";

/**
 * How every attributes screen changes the schema (docs/attributes.md
 * § Changes).
 *
 * A screen parses its form, then hands a pure change to `commitSchemaChange`
 * with the revision its loader gave it. The change runs against the document
 * as it is now, the result is checked whole, the write is conditional on the
 * revision, and the audit trail gets a line. Every route shares this so no
 * route can store an unchecked document or overwrite a newer one.
 */

export type SchemaActionResult =
  | { ok: true; message: string; revision: number }
  | { ok: false; message: string };

export const CONFLICT_MESSAGE =
  "The schema changed since this page was opened, so nothing was saved. Reload the page and make the change again.";

/** Short, readable ids that survive an export: `attr_3f9a1c2b`. */
export const newId: IdSource = (prefix) =>
  `${prefix}_${randomBytes(4).toString("hex")}`;

/** The revision a form was made against; missing or malformed is 0. */
export function revisionFrom(formData: FormData): number {
  const raw = Number(formData.get("revision") ?? "");
  return Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

export async function commitSchemaChange(
  principal: Principal,
  expectedRevision: number,
  event: string,
  change: (schema: AttributeSchema) => MutationResult,
  actor: string | null,
): Promise<SchemaActionResult> {
  const current = await getAttributeSchema(principal);
  if (current.revision !== expectedRevision) {
    return { ok: false, message: CONFLICT_MESSAGE };
  }

  const result = change(current.schema);
  if (!result.ok) return { ok: false, message: result.message };

  const problems = schemaProblems(result.schema);
  if (problems.length > 0) {
    return {
      ok: false,
      message: `That change would leave the schema inconsistent: ${problems[0]}`,
    };
  }

  const saved = await saveAttributeSchema(
    principal,
    result.schema,
    expectedRevision,
  );
  if (!saved.ok) return { ok: false, message: CONFLICT_MESSAGE };

  await appendEvent(principal, {
    entityType: "attribute_schema",
    event,
    detail: { by: actor, revision: saved.revision, summary: result.message },
  });
  return { ok: true, message: result.message, revision: saved.revision };
}
