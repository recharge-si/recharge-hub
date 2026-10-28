import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { getAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  applyDefinitions,
  readDefinitions,
} from "~/adapters/shopify/metafield-definitions";
import {
  planDefinitions,
  type DefinitionPlan,
} from "~/domain/attributes/definitions";
import type { Principal } from "~/domain/types";

/**
 * The Definitions tab's two paths (docs/attributes.md, Metafield
 * definitions): a preview that only reads, and the create that does what the
 * preview promised. Both read the shop's plan through the principal, so one
 * shop's run never sees another's plan.
 */

export async function previewDefinitions(
  admin: AdminApiContext,
  principal: Principal,
): Promise<DefinitionPlan> {
  const { schema } = await getAttributeSchema(principal);
  return planDefinitions(schema, await readDefinitions(admin));
}

export interface CreateRun {
  /** Attribute ids whose definition this press made. */
  created: string[];
  failed: Array<{ attributeId: string; name: string; message: string }>;
  /** The plan after the run, re-read from Shopify. */
  plan: DefinitionPlan;
}

/**
 * Creates the `create` rows of a fresh preview. It plans again from what
 * Shopify holds now, so a second press (or a second tab) creates nothing
 * twice, and logs one `attribute_schema.definitions_created` event per
 * press with the counts.
 */
export async function createPlannedDefinitions(
  admin: AdminApiContext,
  principal: Principal,
  actor: string | null,
): Promise<CreateRun> {
  const { schema } = await getAttributeSchema(principal);
  const before = planDefinitions(schema, await readDefinitions(admin));
  const outcomes = await applyDefinitions(admin, before);

  const created = outcomes
    .filter((o) => o.result === "created")
    .map((o) => o.attributeId);
  const names = new Map(schema.attributes.map((a) => [a.id, a.name]));
  const failed = outcomes.flatMap((o) =>
    o.result === "failed"
      ? [
          {
            attributeId: o.attributeId,
            name: names.get(o.attributeId) ?? o.attributeId,
            message: o.message,
          },
        ]
      : [],
  );

  await appendEvent(principal, {
    entityType: "attribute_schema",
    event: "attribute_schema.definitions_created",
    detail: {
      by: actor,
      created: created.length,
      failed: failed.length,
      keys: before.rows
        .filter((row) => created.includes(row.attributeId))
        .map((row) => row.fullKey),
    },
  });

  return {
    created,
    failed,
    plan: planDefinitions(schema, await readDefinitions(admin)),
  };
}
