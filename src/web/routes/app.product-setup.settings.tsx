import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { getAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { schemaFromCsv } from "~/domain/attributes/csv";
import { workspaceState } from "~/domain/attributes/impact";
import { clearRule } from "~/domain/attributes/mutations";
import { pathOf } from "~/domain/attributes/resolve";
import { mergeRigPack } from "~/domain/attributes/rig-pack";
import { parseAttributeSchema } from "~/domain/attributes/schema";
import { starterSchema } from "~/domain/attributes/starter";
import { emptySchema } from "~/domain/attributes/types";
import { ConfirmModal } from "~/web/components/confirm-modal";
import { DownloadButton } from "~/web/components/download-button";
import { LearnMore } from "~/web/components/learn-more";
import { ProductSetupNav } from "~/web/components/product-setup-nav";
import { attributeAiPrompt } from "~/web/lib/attribute-ai-prompt";
import { PRODUCT_SETUP_ROUTES, countOf } from "~/web/lib/attributes";
import {
  commitSchemaChange,
  newId,
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
 * file (JSON, or CSV for a spreadsheet or an AI assistant, with the prompt
 * that explains the CSV to one), the checks, the exceptions single types have made, and starting
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

/** A refused CSV says every row that is wrong, not only the first. */
type SettingsActionResult =
  SchemaActionResult | { ok: false; message: string; problems: string[] };

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<SettingsActionResult> => {
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
      if (field("format") === "csv") {
        const imported = schemaFromCsv(text, newId);
        if (!imported.ok)
          return {
            ok: false,
            message:
              "Import rejected, nothing changed. Fix these rows and import the file again.",
            problems: imported.problems,
          };
        return commit("attribute_schema.imported", () => ({
          ok: true,
          schema: imported.schema,
          message: `Imported ${countOf(imported.schema.types.length, "product type")} and ${countOf(imported.schema.attributes.length, "attribute")}.`,
        }));
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return {
          ok: false,
          message:
            "The file is neither CSV nor JSON. Export a file from this page and import that, or a file from the standalone builder.",
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
    case "rig-pack": {
      const current = await getAttributeSchema(principal);
      if (
        current.revision === revision &&
        !mergeRigPack(current.schema).changed
      )
        return {
          ok: true,
          message: "Already in the plan",
          revision: current.revision,
        };
      return commit("attribute_schema.rig_pack.added", (schema) => {
        const merged = mergeRigPack(schema);
        const kept = merged.skipped.length;
        return {
          ok: true,
          schema: merged.schema,
          message: `Added ${countOf(merged.added.attributes, "rig attribute")} and ${countOf(merged.added.types, "product type")}${kept > 0 ? `; ${kept} already in the plan` : ""}.`,
        };
      });
    }
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
    format: "csv" | "json";
  } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [promptNote, setPromptNote] = useState<string | null>(null);

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
    const text = await file.text();
    const json =
      /\.json$/i.test(file.name) ||
      (!/\.csv$/i.test(file.name) && /^\s*[{[]/.test(text));
    setPendingImport({ name: file.name, text, format: json ? "json" : "csv" });
    (
      document.getElementById(IMPORT_MODAL_ID) as Overlay | null
    )?.showOverlay?.();
  };

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(attributeAiPrompt());
      setPromptNote(null);
      if (typeof shopify !== "undefined") shopify.toast.show("Prompt copied");
    } catch {
      setPromptNote(
        "The browser did not allow copying here. Download the prompt instead.",
      );
    }
  };

  const downloadPrompt = () => {
    const blob = new Blob([attributeAiPrompt()], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "product-setup-ai-prompt.txt";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const stated = `${countOf(counts.types, "product type")} and ${countOf(counts.attributes, "attribute")}`;

  return (
    <s-page heading="Metafields" inlineSize="large">
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
              submit({
                intent: "import",
                format: pendingImport.format,
                file: pendingImport.text,
              });
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

      <s-query-container>
        <s-stack direction="block" gap="base">
          <ProductSetupNav current="settings" />

          {result && !result.ok ? (
            <s-banner tone="critical" heading="That did not work">
              <s-stack direction="block" gap="small-300">
                <s-paragraph>{result.message}</s-paragraph>
                {"problems" in result ? (
                  <s-unordered-list>
                    {result.problems.map((problem) => (
                      <s-list-item key={problem}>{problem}</s-list-item>
                    ))}
                  </s-unordered-list>
                ) : null}
              </s-stack>
            </s-banner>
          ) : null}

          <s-section>
            <s-stack direction="block" gap="small-300">
              <CardHeader
                title="Checks"
                subtitle={
                  stage === "ok" ? `${stated} pass every check.` : summary
                }
              />
              {problems.map((problem) => (
                <s-grid
                  key={problem.id}
                  gridTemplateColumns="auto 1fr auto"
                  gap="small-300"
                  alignItems="center"
                >
                  <s-icon type="alert-circle" tone="warning" />
                  <s-text>{problem.message}</s-text>
                  {problem.href !== PRODUCT_SETUP_ROUTES.settings ? (
                    <s-button href={problem.href}>Review</s-button>
                  ) : (
                    <span />
                  )}
                </s-grid>
              ))}
            </s-stack>
          </s-section>

          <s-section>
            <s-stack direction="block" gap="base">
              <CardHeader
                title="Import and export"
                subtitle={
                  updatedAt
                    ? `The whole plan as one file. Last changed ${formatDateTime(updatedAt)}.`
                    : "The whole plan as one file. Nothing has been saved yet."
                }
              >
                <DownloadButton
                  href={PRODUCT_SETUP_ROUTES.exportCsv}
                  fallbackName="product-setup.csv"
                  icon="export"
                >
                  Export CSV
                </DownloadButton>
                <DownloadButton
                  href={PRODUCT_SETUP_ROUTES.export}
                  fallbackName="product-setup.json"
                  icon="export"
                  disabled={empty}
                >
                  Export JSON
                </DownloadButton>
                <s-button
                  icon="import"
                  onClick={() => fileInput.current?.click()}
                  {...(busy ? { disabled: true } : {})}
                >
                  Import
                </s-button>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".csv,text/csv,.json,application/json"
                  hidden
                  onChange={(event) => {
                    void chooseFile(event.currentTarget.files?.[0]);
                    event.currentTarget.value = "";
                  }}
                />
              </CardHeader>
              {importError ? (
                <s-text tone="critical">{importError}</s-text>
              ) : null}
              <LearnMore label="About the files">
                <s-paragraph>
                  CSV opens in a spreadsheet and is what an AI assistant edits;
                  with nothing planned it downloads as an empty template. JSON
                  is the exact backup. Either replaces the whole plan, and is
                  checked whole first: a refused file lists every wrong row and
                  changes nothing.
                </s-paragraph>
                <s-paragraph>
                  In the CSV, the record column says what a row is: type, set,
                  attribute, option, attach, requirement or remove. Types are
                  named by their full path (All products &gt; Windsurf &gt;
                  Sails), sets and attributes by name.
                </s-paragraph>
              </LearnMore>
            </s-stack>
          </s-section>

          <s-section>
            <s-stack direction="block" gap="base">
              <CardHeader
                title="Plan with an AI assistant"
                subtitle="Give Claude the prompt and your exported CSV, then import the CSV it returns."
              >
                <s-button icon="clipboard" onClick={() => void copyPrompt()}>
                  Copy prompt
                </s-button>
                <s-button icon="download" onClick={downloadPrompt}>
                  Download prompt
                </s-button>
              </CardHeader>
              {promptNote ? (
                <s-text tone="critical">{promptNote}</s-text>
              ) : null}
              <LearnMore label="Step by step">
                <s-ordered-list>
                  <s-list-item>
                    Export CSV to hand over your current plan.
                  </s-list-item>
                  <s-list-item>
                    Paste the prompt into Claude, attach the CSV and describe
                    your products: a product list, supplier sheets or web pages.
                  </s-list-item>
                  <s-list-item>
                    Ask for changes until the plan is right, then save the CSV
                    it returns.
                  </s-list-item>
                  <s-list-item>
                    Import it. The checks above say what is still missing.
                  </s-list-item>
                </s-ordered-list>
                <s-paragraph>
                  This app sends nothing to an AI. An import replaces the whole
                  plan, so the prompt asks for all of it back.
                </s-paragraph>
              </LearnMore>
            </s-stack>
          </s-section>

          <s-section>
            <s-stack direction="block" gap="small-300">
              <CardHeader
                title="Exceptions on single product types"
                subtitle={
                  rules.length === 0
                    ? "None. Every type takes what it inherits."
                    : "A requirement changed or an attribute removed on one type only. Reset returns the type to what it inherits."
                }
              />
              {rules.map((rule) => (
                <s-grid
                  key={`${rule.kind}-${rule.id}`}
                  gridTemplateColumns="1fr auto"
                  gap="small-300"
                  alignItems="center"
                >
                  <s-stack direction="block" gap="none">
                    <s-text>
                      <s-text type="strong">{rule.attribute}</s-text>
                      {` · ${rule.what}`}
                    </s-text>
                    <s-link href={PRODUCT_SETUP_ROUTES.type(rule.typeId)}>
                      {rule.type}
                    </s-link>
                  </s-stack>
                  <s-button
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
              ))}
            </s-stack>
          </s-section>

          <s-section>
            <CardHeader
              title="Rig attributes"
              subtitle="Adds the product types and measurements the rig builder reads: sails, masts, boards, booms, bases, fins. Nothing in Shopify changes."
            >
              <s-button
                onClick={() => submit({ intent: "rig-pack" })}
                {...(busy ? { disabled: true } : {})}
              >
                Add rig attributes
              </s-button>
            </CardHeader>
          </s-section>

          <s-section>
            <CardHeader
              title="Start again"
              subtitle="Replaces the whole plan. Nothing in Shopify changes."
            >
              <s-button
                command="--show"
                commandFor={STARTER_MODAL_ID}
                {...(busy ? { disabled: true } : {})}
              >
                Load the example
              </s-button>
              <s-button
                tone="critical"
                command="--show"
                commandFor={CLEAR_MODAL_ID}
                {...(busy || empty ? { disabled: true } : {})}
              >
                Remove everything
              </s-button>
            </CardHeader>
          </s-section>
        </s-stack>
      </s-query-container>
    </s-page>
  );
}

/**
 * A card's title and what it is, with its actions at the trailing edge:
 * one line per card, so the page reads as a list of settings.
 */
function CardHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children?: ReactNode;
}) {
  return (
    <s-grid
      gridTemplateColumns="@container (inline-size <= 640px) 1fr, 1fr auto"
      gap="base"
      alignItems="center"
    >
      <s-stack direction="block" gap="small-500">
        <s-heading>{title}</s-heading>
        <s-text color="subdued">{subtitle}</s-text>
      </s-stack>
      {children ? (
        <s-stack direction="inline" gap="small-300">
          {children}
        </s-stack>
      ) : null}
    </s-grid>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
