import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { z } from "zod";

import { getLogger } from "~/adapters/observability/logger.server";

/**
 * Shopify's own automatic discounts, read so a sale campaign can warn that
 * checkout may discount the same products again
 * (docs/sale-campaigns.md § Shopify API operations, brief §14).
 *
 * Which products an automatic discount applies to is not something this app
 * evaluates — the conditions live in Shopify, and for a Functions-backed
 * discount in code this app cannot read. What it can say is that active
 * automatic discounts exist, and name them.
 *
 * Needs `read_discounts`. A shop that has not granted it yet answers
 * `unavailable`, and the preview says "not checked" rather than "none".
 */

const AUTOMATIC_DISCOUNTS_QUERY = `#graphql
  query OrchestratorAutomaticDiscounts {
    discountNodes(first: 50, query: "status:active AND method:automatic") {
      nodes {
        id
        discount {
          __typename
          ... on DiscountAutomaticBasic { title status startsAt endsAt }
          ... on DiscountAutomaticBxgy { title status startsAt endsAt }
          ... on DiscountAutomaticFreeShipping { title status startsAt endsAt }
          ... on DiscountAutomaticApp { title status startsAt endsAt }
        }
      }
    }
  }
`;

const discountsSchema = z.object({
  data: z
    .object({
      discountNodes: z
        .object({
          nodes: z.array(
            z.object({
              id: z.string(),
              discount: z
                .object({
                  __typename: z.string(),
                  title: z.string().optional(),
                  status: z.string().optional(),
                  startsAt: z.string().nullable().optional(),
                  endsAt: z.string().nullable().optional(),
                })
                .passthrough(),
            }),
          ),
        })
        .nullable(),
    })
    .nullable()
    .optional(),
  errors: z
    .array(
      z
        .object({
          message: z.string(),
          extensions: z
            .object({ code: z.string().optional() })
            .passthrough()
            .optional(),
        })
        .passthrough(),
    )
    .optional(),
});

export interface AutomaticDiscount {
  id: string;
  title: string;
  kind: string;
  startsAt: string | null;
  endsAt: string | null;
}

export type AutomaticDiscountsResult =
  | { kind: "read"; discounts: AutomaticDiscount[] }
  | { kind: "unavailable"; reason: string };

const KIND_LABEL: Record<string, string> = {
  DiscountAutomaticBasic: "amount off",
  DiscountAutomaticBxgy: "buy X get Y",
  DiscountAutomaticFreeShipping: "free shipping",
  DiscountAutomaticApp: "app discount",
};

export async function listActiveAutomaticDiscounts(
  admin: AdminApiContext,
): Promise<AutomaticDiscountsResult> {
  let parsed: z.infer<typeof discountsSchema>;
  try {
    const response = await admin.graphql(AUTOMATIC_DISCOUNTS_QUERY, {
      tries: 2,
    });
    parsed = discountsSchema.parse(await response.json());
  } catch (error) {
    getLogger().warn({ err: error }, "Automatic discounts could not be read");
    return {
      kind: "unavailable",
      reason: "Shopify did not answer the discounts query.",
    };
  }

  const denied = parsed.errors?.find(
    (error) =>
      error.extensions?.code === "ACCESS_DENIED" ||
      /access denied|read_discounts/i.test(error.message),
  );
  if (denied) {
    return {
      kind: "unavailable",
      reason:
        "The app has not been granted permission to read discounts yet. Open the app again to approve it.",
    };
  }
  if (parsed.errors && parsed.errors.length > 0) {
    return { kind: "unavailable", reason: parsed.errors[0]?.message ?? "" };
  }

  const nodes = parsed.data?.discountNodes?.nodes ?? [];
  return {
    kind: "read",
    discounts: nodes.map((node) => ({
      id: node.id,
      title: node.discount.title ?? "(untitled)",
      kind: KIND_LABEL[node.discount.__typename] ?? node.discount.__typename,
      startsAt: node.discount.startsAt ?? null,
      endsAt: node.discount.endsAt ?? null,
    })),
  };
}
