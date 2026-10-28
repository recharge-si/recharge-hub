import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";

import { TypeMenuError, call } from "~/adapters/shopify/type-menu";
import type {
  DefinitionDraft,
  DefinitionPlan,
  ExistingDefinition,
  OwnerType,
} from "~/domain/attributes/definitions";

/**
 * Metafield definitions as the Definitions tab needs them
 * (docs/attributes.md § Metafield definitions): read the shop's, and create
 * the ones the plan implies. Shares the call/refusal plumbing of the store
 * menu's runtime definition (`type-menu.ts`), which stays the owner of
 * `recharge.product_type_path`.
 *
 * Reading needs `read_products` and creating needs `write_products` for the
 * PRODUCT and PRODUCTVARIANT owner types; both are already granted, so no
 * scope is added.
 */

export { TypeMenuError as DefinitionError };

const OWNER_TYPES: readonly OwnerType[] = ["PRODUCT", "PRODUCTVARIANT"];
/** Definitions per page; Shopify allows up to 250. */
export const DEFINITION_PAGE_SIZE = 100;

const READ_QUERY = `#graphql
  query OrchestratorPlanDefinitions($ownerType: MetafieldOwnerType!, $first: Int!, $after: String, $namespace: String, $key: String) {
    metafieldDefinitions(ownerType: $ownerType, first: $first, after: $after, namespace: $namespace, key: $key) {
      nodes { id namespace key name type { name } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const pageSchema = z.object({
  metafieldDefinitions: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        namespace: z.string(),
        key: z.string(),
        name: z.string(),
        type: z.object({ name: z.string() }),
      }),
    ),
    pageInfo: z.object({
      hasNextPage: z.boolean(),
      endCursor: z.string().nullable(),
    }),
  }),
});

/** Every definition on products and variants, every page. */
export async function readDefinitions(
  admin: AdminApiContext,
  filter: { namespace?: string; key?: string } = {},
): Promise<ExistingDefinition[]> {
  const found: ExistingDefinition[] = [];
  for (const ownerType of OWNER_TYPES) {
    let after: string | null = null;
    for (;;) {
      const page: z.infer<typeof pageSchema> = await call(
        admin,
        READ_QUERY,
        {
          ownerType,
          first: DEFINITION_PAGE_SIZE,
          after,
          namespace: filter.namespace ?? null,
          key: filter.key ?? null,
        },
        pageSchema,
      );
      for (const node of page.metafieldDefinitions.nodes)
        found.push({
          ownerType,
          namespace: node.namespace,
          key: node.key,
          type: node.type.name,
          name: node.name,
        });
      const info = page.metafieldDefinitions.pageInfo;
      if (!info.hasNextPage || !info.endCursor) break;
      after = info.endCursor;
    }
  }
  return found;
}

const CREATE = `#graphql
  mutation OrchestratorPlanDefinitionCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id }
      userErrors { field message code }
    }
  }
`;

const createSchema = z.object({
  metafieldDefinitionCreate: z.object({
    createdDefinition: z.object({ id: z.string() }).nullable(),
    userErrors: z.array(
      z.object({
        field: z.array(z.string()).nullable().optional(),
        message: z.string(),
        code: z.string().nullable().optional(),
      }),
    ),
  }),
});

/** What `metafieldDefinitionCreate` is sent for one draft. */
export function createInput(draft: DefinitionDraft): Record<string, unknown> {
  return {
    ownerType: draft.ownerType,
    namespace: draft.namespace,
    key: draft.key,
    name: draft.name,
    ...(draft.description ? { description: draft.description } : {}),
    type: draft.type,
    ...(draft.validations.length > 0 ? { validations: draft.validations } : {}),
    ...(draft.storefrontAccess
      ? { access: { storefront: draft.storefrontAccess } }
      : {}),
  };
}

export type DefinitionOutcome =
  | { attributeId: string; result: "created" }
  | { attributeId: string; result: "unchanged" }
  | { attributeId: string; result: "failed"; message: string };

/**
 * Creates each draft once. An "already taken" answer is a re-read: the
 * definition exists now (a re-run, or another press), so the row is
 * `unchanged`, not a failure. Any other refusal for one definition is that
 * row's failure with Shopify's words and the others carry on; a refusal
 * that is about the app (a permission not yet approved) stops the run, since
 * every row would meet it.
 */
export async function createDefinitions(
  admin: AdminApiContext,
  drafts: ReadonlyArray<{ attributeId: string; draft: DefinitionDraft }>,
): Promise<DefinitionOutcome[]> {
  const outcomes: DefinitionOutcome[] = [];
  for (const { attributeId, draft } of drafts) {
    let reply: z.infer<typeof createSchema>;
    try {
      reply = await call(
        admin,
        CREATE,
        { definition: createInput(draft) },
        createSchema,
      );
    } catch (error) {
      if (error instanceof TypeMenuError && /permission/i.test(error.message))
        throw error;
      outcomes.push({
        attributeId,
        result: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const { createdDefinition, userErrors } = reply.metafieldDefinitionCreate;
    if (userErrors.length === 0 && createdDefinition) {
      outcomes.push({ attributeId, result: "created" });
      continue;
    }
    if (userErrors.some((e) => e.code === "TAKEN")) {
      const now = await readDefinitions(admin, {
        namespace: draft.namespace,
        key: draft.key,
      });
      const same = now.find(
        (d) => d.ownerType === draft.ownerType && d.type === draft.type,
      );
      outcomes.push(
        same
          ? { attributeId, result: "unchanged" }
          : {
              attributeId,
              result: "failed",
              message: `${draft.namespace}.${draft.key} already exists with another type.`,
            },
      );
      continue;
    }
    outcomes.push({
      attributeId,
      result: "failed",
      message:
        userErrors.map((e) => e.message).join("; ") ||
        "Shopify did not create the definition.",
    });
  }
  return outcomes;
}

/**
 * Creates what a plan says to create, and nothing else: an `unchanged`,
 * `conflict`, `managed` or `skipped` row never reaches Shopify.
 */
export async function applyDefinitions(
  admin: AdminApiContext,
  plan: DefinitionPlan,
): Promise<DefinitionOutcome[]> {
  const drafts = plan.rows.flatMap((row) =>
    row.status === "create" && row.draft
      ? [{ attributeId: row.attributeId, draft: row.draft }]
      : [],
  );
  return createDefinitions(admin, drafts);
}
