import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useRef, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { getAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { workspaceState } from "~/domain/attributes/impact";
import { clearRule } from "~/domain/attributes/mutations";
import { pathOf } from "~/domain/attributes/resolve";
import { parseAttributeSchema } from "~/domain/attributes/schema";
import { starterSchema } from "~/domain/attributes/starter";
import { emptySchema } from "~/domain/attributes/types";
import { ConfirmModal } from "~/web/components/confirm-modal";
import { DownloadButton } from "~/web/components/download-button";
import { ProductSetupNav } from "~/web/components/product-setup-nav";
import { PRODUCT_SETUP_ROUTES, countOf } from "~/web/lib/attributes";
import {
  commitSchemaChange,
  revisionFrom,
  type SchemaActionResult,
} from "~/web/lib/attributes.server";
import { formatDateTime } from "~/web/lib/datetime";
import {
  actorFromSession,
  principalFromSession,
} from "~/web/lib/principal.server";

/**
 * Product setup settings (docs/attributes.md § Screens): the schema as a
 * file, the checks, the exceptions single types have made, and starting
 * again. Everything a person needs rarely, one link from the work.
 */
const IMPORT_MODAL_ID = "import-schema";
const STARTER_MODAL_ID = "load-starter";
const CLEAR_MODAL_ID = "clear-schema";

const IMPORT_LIMIT = 5 * 1024 * 1024;

const AREA_HREF = {
  types: PRODUCT_SETUP_ROUTES.types,
  attributes: PRODUCT_SETUP_ROUTES.attributes,
  settings: PRODUCT_SETUP_ROUTES.settings,
} as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const { schema, revision, updatedAt } = await getAttributeSchema(principal);
  const attributeName = (id: string) =>
    schema.attributes.find((a) => a.id === id)?.name ?? "";
  const state = workspaceState(schema);

  return {
    revision,
    updatedAt: updatedAt?.toISOString() ?? null,
    empty: state.stage === "empty",
    stage: state.stage,
    summary: state.summary,
    problems: state.problems.map((problem) => ({
      ...problem,
      href: AREA_HREF[problem.area],
    })),
    counts: {
      types: schema.types.length,
      attributes: schema.attributes.length,
    },
    rules: [
      ...schema.overrides.map((row) => ({
        kind: "override" as const,
        id: row.id,
        typeId: row.typeId,
        type: pathOf(schema, row.typeId).join(" › "),
        attribute: attributeName(row.attributeId),
        what: row.required ? "Required here" : "Optional here",
      })),
      ...schema.exclusions.map((row) => ({
        kind: "exclusion" as const,
        id: row.id,
        typeId: row.typeId,
        type: pathOf(schema, row.typeId).join(" › "),
        attribute: attributeName(row.attributeId),
        what: "Removed here",
      })),
    ].sort(
      (a, b) =>
        a.type.localeCompare(b.type) || a.attribute.localeCompare(b.attribute),
    ),
  };
};

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<SchemaActionResult> => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const actor = actorFromSession(session);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const revision = revisionFrom(formData);
  const field = (name: string) => String(formData.get(name) ?? "");
  const commit = (
    event: string,
    change: Parameters<typeof commitSchemaChange>[3],
  ) => commitSchemaChange(principal, revision, event, change, actor);

  switch (intent) {
    case "import": {
      const text = field("file");
      if (text.length > IMPORT_LIMIT)
        return {
          ok: false,
          message: "A schema file must be smaller than 5 MB.",
        };
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return {
          ok: false,
          message:
            "The file is not JSON. Export a schema from this page or from the standalone builder and import that.",
        };
      }
      const parsed = parseAttributeSchema(raw);
      if (!parsed.ok)
        return {
          ok: false,
          message: `Import rejected, nothing changed. ${parsed.message}`,
        };
      return commit("attribute_schema.imported", () => ({
        ok: true,
        schema: parsed.schema,
        message: `Imported ${countOf(parsed.schema.types.length, "product type")} and ${countOf(parsed.schema.attributes.length, "attribute")}.`,
      }));
    }
    case "starter":
      return commit("attribute_schema.starter.loaded", () => ({
        ok: true,
        schema: starterSchema(),
        message: "Example loaded.",
      }));
    case "clear":
      return commit("attribute_schema.cleared", () => ({
        ok: true,
        schema: emptySchema(),
        message: "Everything removed.",
      }));
    case "clear-rule": {
      const kind = field("kind");
      if (kind !== "override" && kind !== "exclusion")
        return { ok: false, message: "Unknown action." };
      return commit("attribute_schema.rule.cleared", (schema) =>
        clearRule(schema, kind, field("ruleId")),
      );
    }
    default:
      return { ok: false, message: "Unknown action." };
  }
};

type Overlay = { showOverlay?: () => void };

export default function ProductSetupSettings() {
  const {
    revision,
    updatedAt,
    empty,
    stage,
    summary,
    problems,
    counts,
    rules,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;

  const fileInput = useRef<HTMLInputElement>(null);
  const [pendingImport, setPendingImport] = useState<{
    name: string;
    text: string;
  } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [result]);

  const submit = (fields: Record<string, string>) =>
    fetcher.submit(
      { ...fields, revision: String(revision) },
      { method: "post" },
    );

  const chooseFile = async (file: File | undefined) => {
    setImportError(null);
    if (!file) return;
    if (file.size > IMPORT_LIMIT) {
      setImportError("A schema file must be smaller than 5 MB.");
      return;
    }
    setPendingImport({ name: file.name, text: await file.text() });
    (
      document.getElementById(IMPORT_MODAL_ID) as Overlay | null
    )?.showOverlay?.();
  };

  const stated = `${countOf(counts.types, "product type")} and ${countOf(counts.attributes, "attribute")}`;

  return (
    <s-page heading="Metafields">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>

      <s-modal
        id={IMPORT_MODAL_ID}
        heading="Replace everything with this file?"
      >
        <s-paragraph>
          {`${stated} are replaced by what “${pendingImport?.name ?? ""}” holds. The file is checked whole before anything changes; export a backup first if you may want the current plan back.`}
        </s-paragraph>
        <s-button
          slot="primary-action"
          variant="primary"
          command="--hide"
          commandFor={IMPORT_MODAL_ID}
          onClick={() => {
            if (pendingImport)
              submit({ intent: "import", file: pendingImport.text });
            setPendingImport(null);
          }}
        >
          Replace
        </s-button>
        <s-button
          slot="secondary-actions"
          command="--hide"
          commandFor={IMPORT_MODAL_ID}
          onClick={() => setPendingImport(null)}
        >
          Keep it
        </s-button>
      </s-modal>

      <ConfirmModal
        id={STARTER_MODAL_ID}
        heading="Replace everything with the example?"
        confirmLabel="Replace"
        onConfirm={() => submit({ intent: "starter" })}
      >
        <s-paragraph>
          {`${stated} are replaced by the example of sails, boards and wetsuits. Export a backup first if you may want them back.`}
        </s-paragraph>
      </ConfirmModal>

      <ConfirmModal
        id={CLEAR_MODAL_ID}
        heading="Remove everything?"
        confirmLabel="Remove everything"
        onConfirm={() => submit({ intent: "clear" })}
      >
        <s-paragraph>
          {`${stated}, every set and every exception are removed. Export a backup first if you may want them back.`}
        </s-paragraph>
      </ConfirmModal>

      <s-stack direction="block" gap="base">
        <ProductSetupNav current="settings" />

        {result && !result.ok ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        <s-section heading="Checks">
          <s-stack direction="block" gap="small-300">
            {stage === "ok" ? (
              <s-text color="subdued">
                {`${stated} pass every check: each product type has attributes, each attribute is used and has a Shopify field, and every choice has options.`}
              </s-text>
            ) : (
              <s-text color="subdued">{summary}</s-text>
            )}
            {problems.map((problem) => (
              <s-stack
                key={problem.id}
                direction="inline"
                gap="small-300"
                alignItems="center"
              >
                <s-icon type="alert-circle" tone="warning" />
                <s-text>{problem.message}</s-text>
                {problem.href !== PRODUCT_SETUP_ROUTES.settings ? (
                  <s-link href={problem.href}>Review</s-link>
                ) : null}
              </s-stack>
            ))}
          </s-stack>
        </s-section>

        <s-section heading="Import and export">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              {updatedAt
                ? `The whole plan as one file. Last changed ${formatDateTime(updatedAt)}.`
                : "The whole plan as one file. Nothing has been saved yet."}
            </s-text>
            <s-stack direction="inline" gap="small-300">
              <DownloadButton
                href={PRODUCT_SETUP_ROUTES.export}
                fallbackName="product-setup.json"
                icon="export"
                disabled={empty}
              >
                Export JSON
              </DownloadButton>
              <s-button
                onClick={() => fileInput.current?.click()}
                {...(busy ? { disabled: true } : {})}
              >
                Import JSON
              </s-button>
              <input
                ref={fileInput}
                type="file"
                accept=".json,application/json"
                hidden
                onChange={(event) => {
                  void chooseFile(event.currentTarget.files?.[0]);
                  event.currentTarget.value = "";
                }}
              />
            </s-stack>
            {importError ? (
              <s-text tone="critical">{importError}</s-text>
            ) : null}
            <s-text color="subdued">
              A file exported here or from the standalone builder. It is checked
              whole before it replaces anything.
            </s-text>
          </s-stack>
        </s-section>

        <s-section heading="Exceptions on single product types">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              A requirement changed or an attribute removed on one exact type.
              These pass to no descendant; resetting one returns the type to
              what it inherits.
            </s-text>
            {rules.length === 0 ? (
              <s-text color="subdued">
                None. Every type takes what it inherits.
              </s-text>
            ) : (
              rules.map((rule) => (
                <s-grid
                  key={`${rule.kind}-${rule.id}`}
                  gridTemplateColumns="1fr auto"
                  gap="small-300"
                  alignItems="center"
                >
                  <s-stack direction="block" gap="small-500">
                    <s-text>
                      <s-text type="strong">{rule.attribute}</s-text>
                      {` · ${rule.what}`}
                    </s-text>
                    <s-link href={PRODUCT_SETUP_ROUTES.type(rule.typeId)}>
                      {rule.type}
                    </s-link>
                  </s-stack>
                  <s-button
                    variant="tertiary"
                    accessibilityLabel={`Reset ${rule.attribute} on ${rule.type}`}
                    onClick={() =>
                      submit({
                        intent: "clear-rule",
                        kind: rule.kind,
                        ruleId: rule.id,
                      })
                    }
                    {...(busy ? { disabled: true } : {})}
                  >
                    Reset
                  </s-button>
                </s-grid>
              ))
            )}
          </s-stack>
        </s-section>

        <s-section heading="Start again">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              Either replaces the whole plan. Nothing in Shopify changes; this
              workspace does not write to Shopify.
            </s-text>
            <s-stack direction="inline" gap="small-300">
              <s-button
                command="--show"
                commandFor={STARTER_MODAL_ID}
                {...(busy ? { disabled: true } : {})}
              >
                Replace with the example
              </s-button>
              <s-button
                tone="critical"
                command="--show"
                commandFor={CLEAR_MODAL_ID}
                {...(busy || empty ? { disabled: true } : {})}
              >
                Remove everything
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
