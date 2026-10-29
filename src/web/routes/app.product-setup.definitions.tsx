import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect } from "react";
import {
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { getAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";
import { TypeMenuError } from "~/adapters/shopify/type-menu";
import { authenticate } from "~/adapters/shopify/shopify.server";
import type { DefinitionStatus } from "~/domain/attributes/definitions";
import { LearnMore } from "~/web/components/learn-more";
import { ProductSetupNav } from "~/web/components/product-setup-nav";
import { RigReadiness } from "~/web/components/rig-readiness";
import { PRODUCT_SETUP_ROUTES, countOf } from "~/web/lib/attributes";
import {
  createPlannedDefinitions,
  previewDefinitions,
} from "~/web/lib/definitions.server";
import {
  actorFromSession,
  principalFromSession,
} from "~/web/lib/principal.server";
import { rigReadiness } from "~/web/lib/rig-readiness.server";

/**
 * Definitions (docs/attributes.md, Metafield definitions): which Shopify
 * metafield definitions the plan implies, what Shopify already holds, and one
 * press to create what is missing. The page only reads until that press.
 */

const TYPE_LABEL: Record<string, string> = {
  single_line_text_field: "Text",
  multi_line_text_field: "Multi-line text",
  "list.single_line_text_field": "List of text",
  number_integer: "Whole number",
  number_decimal: "Decimal number",
  boolean: "Yes or no",
  date: "Date",
  dimension: "Dimension",
  weight: "Weight",
  volume: "Volume",
};
const typeLabel = (type: string | null) =>
  type === null ? "" : (TYPE_LABEL[type] ?? type.replace(/_/g, " "));

const STATUS_TEXT: Record<DefinitionStatus, string> = {
  create: "To create",
  unchanged: "Exists",
  conflict: "Conflict",
  managed: "Managed by the store menu",
  skipped: "Not created",
};

type Loaded =
  | { ok: true; plan: Awaited<ReturnType<typeof previewDefinitions>> }
  | { ok: false; message: string };

async function read(
  admin: Parameters<typeof previewDefinitions>[0],
  principal: Parameters<typeof previewDefinitions>[1],
): Promise<Loaded> {
  try {
    return { ok: true, plan: await previewDefinitions(admin, principal) };
  } catch (error) {
    if (error instanceof TypeMenuError)
      return { ok: false, message: error.message };
    throw error;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const { schema } = await getAttributeSchema(principal);
  const loaded = await read(admin, principal);
  const readiness = await rigReadiness(principal, schema);
  if (!loaded.ok)
    return {
      error: loaded.message,
      rows: [],
      foreign: [],
      counts: null,
      readiness,
    };
  const { plan } = loaded;
  return {
    error: null,
    counts: plan.counts,
    rows: plan.rows.map((row) => ({
      attributeId: row.attributeId,
      name: row.name,
      fullKey: row.fullKey,
      where: row.ownerType === "PRODUCTVARIANT" ? "Variant" : "Product",
      type: row.type,
      existingType: row.existingType,
      status: row.status,
      reason: row.reason,
      owned: row.owned,
    })),
    foreign: plan.foreign.map(
      (d) => `${d.namespace}.${d.key} (${typeLabel(d.type)})`,
    ),
    readiness,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  try {
    const run = await createPlannedDefinitions(
      admin,
      principal,
      actorFromSession(session),
    );
    return {
      ok: true as const,
      created: run.created,
      failed: run.failed,
      message:
        run.created.length === 0 && run.failed.length === 0
          ? "Nothing to create."
          : `Created ${countOf(run.created.length, "definition")}.`,
    };
  } catch (error) {
    if (error instanceof TypeMenuError)
      return { ok: false as const, message: error.message };
    throw error;
  }
};

export default function Definitions() {
  const { error, rows, foreign, counts, readiness } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;
  const created = new Set(result?.ok ? result.created : []);
  const toCreate = counts?.create ?? 0;

  useEffect(() => {
    if (result?.ok && typeof shopify !== "undefined")
      shopify.toast.show(result.message);
  }, [result]);

  const summary = counts
    ? [
        `${toCreate} to create`,
        counts.unchanged > 0 ? `${counts.unchanged} exist` : null,
        counts.conflict > 0 ? countOf(counts.conflict, "conflict") : null,
        counts.skipped > 0 ? `${counts.skipped} not created` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <s-page heading="Product setup" inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={() => fetcher.submit({}, { method: "post" })}
        {...(busy || toCreate === 0 ? { disabled: true } : {})}
        {...(busy ? { loading: true } : {})}
      >
        {`Create ${countOf(toCreate, "definition")}`}
      </s-button>

      <s-stack direction="block" gap="base">
        <ProductSetupNav current="definitions" />

        {error ? (
          <s-banner tone="critical" heading="Shopify could not be read">
            <s-paragraph>{error}</s-paragraph>
          </s-banner>
        ) : null}

        {result && !result.ok ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        {result?.ok && result.failed.length > 0 ? (
          <s-banner
            tone="warning"
            heading={`${countOf(result.failed.length, "definition")} not created`}
          >
            {result.failed.map((failure) => (
              <s-paragraph key={failure.attributeId}>
                {`${failure.name}: ${failure.message}`}
              </s-paragraph>
            ))}
          </s-banner>
        ) : null}

        {counts && counts.conflict > 0 ? (
          <s-banner
            tone="warning"
            heading="Some fields already exist with another type"
          >
            <s-paragraph>
              Shopify does not allow a field&apos;s type to change. Choose
              another key for the attribute, or remove the field in Shopify
              first. Nothing is changed for these.
            </s-paragraph>
          </s-banner>
        ) : null}

        <s-section heading="Metafield definitions">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              A definition gives a field a type, so Shopify can filter on it and
              values saved from the plan have the type the plan says. This page
              lists what the plan needs; pressing the button creates only the
              missing ones. Existing definitions are never changed or deleted.
            </s-text>
            {counts === null ? null : rows.length === 0 ? (
              <s-text color="subdued">
                There are no attributes yet.{" "}
                <s-link href={PRODUCT_SETUP_ROUTES.attributes}>Add some</s-link>{" "}
                first.
              </s-text>
            ) : (
              <s-stack direction="block" gap="small-300">
                <s-heading>{summary}</s-heading>
                <s-table variant="auto">
                  <s-table-header-row>
                    <s-table-header listSlot="primary">
                      Attribute
                    </s-table-header>
                    <s-table-header listSlot="secondary">Type</s-table-header>
                    <s-table-header listSlot="kicker">On</s-table-header>
                    <s-table-header listSlot="labeled">
                      Shopify field
                    </s-table-header>
                    <s-table-header listSlot="labeled">Status</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {rows.map((row) => (
                      <s-table-row key={row.attributeId}>
                        <s-table-cell>{row.name}</s-table-cell>
                        <s-table-cell>{typeLabel(row.type)}</s-table-cell>
                        <s-table-cell>{row.where}</s-table-cell>
                        <s-table-cell>
                          <s-text color="subdued">
                            {row.fullKey || "Not mapped"}
                          </s-text>
                          {row.owned || row.fullKey === "" ? null : (
                            <s-text color="subdued">
                              {" "}
                              · not owned by this app
                            </s-text>
                          )}
                        </s-table-cell>
                        <s-table-cell>
                          {row.status === "conflict" ? (
                            <s-badge tone="warning">
                              {`Conflict: Shopify holds ${typeLabel(row.existingType)}`}
                            </s-badge>
                          ) : row.status === "skipped" ? (
                            <s-badge tone="warning">
                              {row.reason ?? STATUS_TEXT.skipped}
                            </s-badge>
                          ) : created.has(row.attributeId) ? (
                            "Created"
                          ) : row.status === "managed" ? (
                            <s-text color="subdued">
                              {STATUS_TEXT.managed}
                            </s-text>
                          ) : (
                            STATUS_TEXT[row.status]
                          )}
                        </s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              </s-stack>
            )}
            {foreign.length > 0 ? (
              <LearnMore
                label={`${countOf(foreign.length, "other definition")} in the store, left alone`}
              >
                {foreign.map((line) => (
                  <s-paragraph key={line}>{line}</s-paragraph>
                ))}
              </LearnMore>
            ) : null}
          </s-stack>
        </s-section>

        {readiness ? <RigReadiness lines={readiness} /> : null}
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
