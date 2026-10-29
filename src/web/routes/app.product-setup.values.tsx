import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useRef, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import {
  importProblems,
  latestImport,
} from "~/adapters/db/repositories/bulk-values.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { OUTCOMES, type Outcome } from "~/domain/values/import";
import { LIMITS } from "~/domain/values/types";
import { DownloadButton } from "~/web/components/download-button";
import { LearnMore } from "~/web/components/learn-more";
import { ProcessHeader } from "~/web/components/process-header";
import { ProductSetupNav } from "~/web/components/product-setup-nav";
import {
  TOO_LARGE,
  applyValues,
  discardValues,
  previewValues,
  typeChoices,
} from "~/web/lib/bulk-values.server";
import { PRODUCT_SETUP_ROUTES, countOf } from "~/web/lib/attributes";
import { formatDateTime } from "~/web/lib/datetime";
import { useLiveRevalidation } from "~/web/lib/live";
import {
  actorFromSession,
  principalFromSession,
} from "~/web/lib/principal.server";

/**
 * Attribute values in bulk (docs/attributes.md § Bulk values): export the
 * products of some types as a spreadsheet, fill in what spec sheets say,
 * upload it and see exactly what would change, then apply. Nothing is
 * written until the second press, and a value someone changed in the
 * meantime is left alone.
 */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const [{ choices, catalogueRead }, current] = await Promise.all([
    typeChoices(principal),
    latestImport(principal),
  ]);
  const problems =
    current && current.status !== "previewed"
      ? await importProblems(principal, current.id)
      : null;
  return {
    choices,
    catalogueRead,
    current: current
      ? {
          id: current.id,
          fileName: current.fileName,
          status: current.status,
          total: current.total,
          done: current.done,
          lastError: current.lastError,
          createdAt: current.createdAt.toISOString(),
          finishedAt: current.finishedAt?.toISOString() ?? null,
          summary: current.summary,
        }
      : null,
    outcomes: problems,
    limits: {
      fileBytes: LIMITS.fileBytes,
      importRows: LIMITS.importRows,
      exportRows: LIMITS.exportRows,
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const actor = actorFromSession(session);
  // A body far past the cap is refused before it is read into memory.
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > LIMITS.fileBytes * 2)
    return { ok: false as const, message: TOO_LARGE };
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  switch (intent) {
    case "preview": {
      const outcome = await previewValues(admin, principal, {
        name: String(form.get("name") ?? ""),
        text: String(form.get("file") ?? ""),
        actor,
      });
      return outcome.ok
        ? { ok: true as const, message: "File read. Check the preview." }
        : outcome;
    }
    case "apply":
    case "continue": {
      const outcome = await applyValues(
        principal,
        String(form.get("id") ?? ""),
        actor,
      );
      return outcome.ok
        ? { ok: true as const, message: "Applying the values" }
        : outcome;
    }
    case "discard": {
      await discardValues(principal, String(form.get("id") ?? ""));
      return { ok: true as const, message: "Preview discarded" };
    }
    default:
      return { ok: false as const, message: "That action is not known." };
  }
};

const OUTCOME_LABEL: Record<Outcome, string> = {
  set: "To set",
  change: "To change",
  clear: "To clear",
  unchanged: "Unchanged",
  skipped: "Skipped",
  error: "Errors",
};

const RESULT_LABEL: Record<string, string> = {
  written: "Written",
  cleared: "Cleared",
  unchanged: "Already as wanted",
  changedMeanwhile: "Changed meanwhile, left alone",
  gone: "No longer in Shopify",
  failed: "Refused by Shopify",
};

function plainOutcome(text: string): string {
  if (text === "changed_meanwhile")
    return "Changed in Shopify since the file was read. Left alone.";
  if (text === "gone") return "No longer in Shopify.";
  return text.startsWith("failed:") ? text.slice(7) : text;
}

export default function BulkValues() {
  const { choices, catalogueRead, current, outcomes, limits } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const fileInput = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [preset, setPreset] = useState<"rig" | "all">("rig");
  const [fileError, setFileError] = useState<string | null>(null);

  const status = current?.status ?? null;
  const working = status === "queued" || status === "running";
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;
  const summary = current?.summary ?? null;
  const ready =
    status === "previewed" && summary !== null && summary.fileErrors.length === 0;
  const canApply = ready && summary.safeToApply;

  useLiveRevalidation({ active: working, idleEveryMs: null });

  useEffect(() => {
    if (result?.ok && typeof shopify !== "undefined")
      shopify.toast.show(result.message);
  }, [result]);

  const rows = choices
    .filter((choice) => selected.includes(choice.typeId))
    .reduce((sum, choice) => sum + choice.variants, 0);
  const tooMany = rows > limits.exportRows;
  const exportHref = `${PRODUCT_SETUP_ROUTES.valuesCsv}?attributes=${preset}&types=${encodeURIComponent(selected.join(","))}`;

  const chooseFile = async (file: File | undefined) => {
    setFileError(null);
    if (!file) return;
    if (file.size > limits.fileBytes) {
      setFileError(
        `The file is larger than ${limits.fileBytes / 1024 / 1024} MB. Split it into parts of up to ${limits.importRows.toLocaleString("en")} rows.`,
      );
      return;
    }
    const text = await file.text();
    fetcher.submit(
      { intent: "preview", name: file.name, file: text },
      { method: "post" },
    );
  };

  const post = (intent: string) =>
    fetcher.submit({ intent, id: current?.id ?? "" }, { method: "post" });

  const total = summary
    ? summary.counts.set + summary.counts.change + summary.counts.clear
    : 0;

  return (
    <s-page heading="Product setup" inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>
      {canApply ? (
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={() => post("apply")}
          {...(busy ? { disabled: true, loading: true } : {})}
        >
          {`Apply ${countOf(total, "change")}`}
        </s-button>
      ) : status === "failed" ? (
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={() => post("continue")}
          {...(busy ? { disabled: true } : {})}
        >
          Continue
        </s-button>
      ) : !working ? (
        <s-button
          slot="primary-action"
          variant={ready ? "secondary" : "primary"}
          onClick={() => fileInput.current?.click()}
          {...(busy ? { disabled: true } : {})}
        >
          {ready || status === "done" ? "Upload another file" : "Upload filled file"}
        </s-button>
      ) : null}
      <input
        ref={fileInput}
        type="file"
        accept=".csv,text/csv"
        hidden
        onChange={(event) => {
          void chooseFile(event.currentTarget.files?.[0]);
          event.currentTarget.value = "";
        }}
      />

      <s-stack direction="block" gap="base">
        <ProductSetupNav current="values" />

        {fileError ? (
          <s-banner tone="critical" heading="That file was not read">
            <s-paragraph>{fileError}</s-paragraph>
          </s-banner>
        ) : null}
        {result && !result.ok ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        <ProcessHeader
          health={
            !current
              ? "never_run"
              : status === "failed"
                ? "needs_attention"
                : "ok"
          }
          lastRun={
            current?.finishedAt
              ? {
                  at: current.finishedAt,
                  outcome: status === "failed" ? "failed" : "completed",
                }
              : null
          }
          mode="manual"
          running={working}
          detail={status === "failed" ? (current?.lastError ?? null) : null}
        />

        {working && current ? (
          <s-banner tone="info" heading="Applying the values">
            <s-paragraph>
              {`${current.done.toLocaleString("en")} of ${current.total.toLocaleString("en")} values checked. You can leave this page; it carries on.`}
            </s-paragraph>
          </s-banner>
        ) : null}

        {status === "done" && outcomes ? (
          <s-section
            heading={`Done${current?.finishedAt ? ` · ${formatDateTime(current.finishedAt)}` : ""}`}
          >
            <s-stack direction="block" gap="small-300">
              <s-text>
                {[
                  ["written", outcomes.counts.written],
                  ["cleared", outcomes.counts.cleared],
                  ["unchanged", outcomes.counts.unchanged],
                ]
                  .filter(([, n]) => Number(n) > 0)
                  .map(([name, n]) =>
                    `${Number(n).toLocaleString("en")} ${RESULT_LABEL[String(name)]?.toLowerCase() ?? name}`,
                  )
                  .join(" · ") || "Nothing needed writing."}
              </s-text>
              {outcomes.counts.changedMeanwhile +
                outcomes.counts.gone +
                outcomes.counts.failed >
              0 ? (
                <s-banner
                  tone="warning"
                  heading={`${(outcomes.counts.changedMeanwhile + outcomes.counts.gone + outcomes.counts.failed).toLocaleString("en")} values were not written`}
                >
                  <s-stack direction="block" gap="small-300">
                    <s-text>
                      {[
                        ["changedMeanwhile", outcomes.counts.changedMeanwhile],
                        ["gone", outcomes.counts.gone],
                        ["failed", outcomes.counts.failed],
                      ]
                        .filter(([, n]) => Number(n) > 0)
                        .map(
                          ([name, n]) =>
                            `${Number(n).toLocaleString("en")} ${RESULT_LABEL[String(name)]?.toLowerCase()}`,
                        )
                        .join(" · ")}
                    </s-text>
                    {outcomes.problems.map((problem) => (
                      <s-text key={`${problem.row}-${problem.attribute}`} color="subdued">
                        {`Row ${problem.row} · ${problem.attribute}: ${plainOutcome(problem.outcome)}`}
                      </s-text>
                    ))}
                    <s-text color="subdued">
                      Export the types again to see their values as they are
                      now, then upload the cells that still need filling.
                    </s-text>
                  </s-stack>
                </s-banner>
              ) : null}
            </s-stack>
          </s-section>
        ) : null}

        {ready && summary ? (
          <s-section heading={`Preview · ${current?.fileName ?? ""}`}>
            <s-stack direction="block" gap="base">
              {summary.errorTotal > 0 ? (
                <s-banner
                  tone="critical"
                  heading={`${countOf(summary.errorTotal, "error")} to fix before anything can be applied`}
                >
                  <s-stack direction="block" gap="small-300">
                    {summary.errors.map((issue) => (
                      <s-text key={`${issue.row}-${issue.column}-${issue.message}`}>
                        {`Row ${issue.row} · ${issue.column}: ${issue.message}`}
                      </s-text>
                    ))}
                    {summary.errorTotal > summary.errors.length ? (
                      <s-text color="subdued">
                        {`And ${(summary.errorTotal - summary.errors.length).toLocaleString("en")} more. Fix these and upload the file again.`}
                      </s-text>
                    ) : (
                      <s-text color="subdued">
                        Fix these in the file and upload it again. Nothing has
                        been written.
                      </s-text>
                    )}
                  </s-stack>
                </s-banner>
              ) : total === 0 ? (
                <s-text>
                  Nothing in this file would change a value
                  {summary.counts.unchanged > 0
                    ? `: ${countOf(summary.counts.unchanged, "cell")} already hold what the file says.`
                    : ". Fill in some cells and upload it again."}
                </s-text>
              ) : (
                <s-text>
                  {`${countOf(total, "value")} would be written. Nothing has been written yet.`}
                </s-text>
              )}

              <s-text color="subdued">
                {OUTCOMES.filter((outcome) => summary.counts[outcome] > 0)
                  .map(
                    (outcome) =>
                      `${OUTCOME_LABEL[outcome]} ${summary.counts[outcome].toLocaleString("en")}`,
                  )
                  .join(" · ") || "No cells were filled in."}
                {` · ${countOf(summary.rowsMatched, "row")} matched of ${summary.rowsRead.toLocaleString("en")}`}
              </s-text>

              {summary.untyped.length > 0 ? (
                <s-text color="subdued">
                  {`Untyped until definitions are created: ${summary.untyped.join(", ")}. Shopify takes these values as the plan's format; create the definitions on the Definitions tab to fix their type.`}
                </s-text>
              ) : null}
              {summary.unknownColumns.length > 0 ? (
                <s-text color="subdued">
                  {`Columns not read, because no attribute matches: ${summary.unknownColumns.join(", ")}.`}
                </s-text>
              ) : null}
              {summary.hintColumns.length > 0 ? (
                <s-text color="subdued">
                  {`Hint columns are never imported. Copy a hint into its attribute column to use it.`}
                </s-text>
              ) : null}

              {summary.perAttribute.length > 0 ? (
                <s-stack direction="block" gap="small-300">
                  <s-heading>By attribute</s-heading>
                  <s-table variant="auto">
                    <s-table-header-row>
                      <s-table-header listSlot="primary">Attribute</s-table-header>
                      {OUTCOMES.map((outcome) => (
                        <s-table-header key={outcome} listSlot="labeled">
                          {OUTCOME_LABEL[outcome]}
                        </s-table-header>
                      ))}
                    </s-table-header-row>
                    <s-table-body>
                      {summary.perAttribute.map((entry) => (
                        <s-table-row key={entry.key}>
                          <s-table-cell>{entry.name}</s-table-cell>
                          {OUTCOMES.map((outcome) => (
                            <s-table-cell key={outcome}>
                              {entry.counts[outcome] > 0
                                ? entry.counts[outcome].toLocaleString("en")
                                : ""}
                            </s-table-cell>
                          ))}
                        </s-table-row>
                      ))}
                    </s-table-body>
                  </s-table>
                </s-stack>
              ) : null}

              {summary.sample.length > 0 ? (
                <s-stack direction="block" gap="small-300">
                  <s-heading>
                    {summary.sample.length < total
                      ? `The first ${summary.sample.length} changes`
                      : "The changes"}
                  </s-heading>
                  <s-table variant="auto">
                    <s-table-header-row>
                      <s-table-header listSlot="primary">Product</s-table-header>
                      <s-table-header listSlot="secondary">Attribute</s-table-header>
                      <s-table-header listSlot="labeled">Before</s-table-header>
                      <s-table-header listSlot="labeled">After</s-table-header>
                      <s-table-header listSlot="labeled">Row</s-table-header>
                    </s-table-header-row>
                    <s-table-body>
                      {summary.sample.map((entry) => (
                        <s-table-row key={`${entry.row}-${entry.attribute}`}>
                          <s-table-cell>
                            {entry.variant && entry.variant !== "Default Title"
                              ? `${entry.product} · ${entry.variant}`
                              : entry.product}
                          </s-table-cell>
                          <s-table-cell>{entry.attribute}</s-table-cell>
                          <s-table-cell>
                            {entry.before === "" ? "(empty)" : entry.before}
                          </s-table-cell>
                          <s-table-cell>
                            {entry.outcome === "clear"
                              ? "(removed)"
                              : entry.after}
                          </s-table-cell>
                          <s-table-cell>{entry.row}</s-table-cell>
                        </s-table-row>
                      ))}
                    </s-table-body>
                  </s-table>
                </s-stack>
              ) : null}

              {summary.skipped.length > 0 ? (
                <LearnMore label={`Skipped cells (${summary.counts.skipped.toLocaleString("en")})`}>
                  {summary.skipped.map((issue) => (
                    <s-paragraph key={`${issue.row}-${issue.column}`}>
                      {`Row ${issue.row} · ${issue.column}: ${issue.message}`}
                    </s-paragraph>
                  ))}
                </LearnMore>
              ) : null}

              <s-stack direction="inline" gap="small-300">
                <s-button
                  onClick={() => post("discard")}
                  {...(busy ? { disabled: true } : {})}
                >
                  Discard preview
                </s-button>
              </s-stack>
              <s-text color="subdued">
                {`The preview is kept until ${formatDateTime(new Date(new Date(current?.createdAt ?? 0).getTime() + LIMITS.previewHours * 3_600_000).toISOString())}. Applying leaves any value that someone changed in Shopify since the file was read.`}
              </s-text>
            </s-stack>
          </s-section>
        ) : null}

        {status === "previewed" && summary && summary.fileErrors.length > 0 ? (
          <s-banner tone="critical" heading="That file cannot be read">
            <s-stack direction="block" gap="small-300">
              {summary.fileErrors.map((message) => (
                <s-text key={message}>{message}</s-text>
              ))}
              <s-text color="subdued">Nothing has been written.</s-text>
            </s-stack>
          </s-banner>
        ) : null}

        <s-section heading="How to">
          <s-stack direction="block" gap="small-300">
            <s-text>
              1. <s-link href="#values-export">Export</s-link> the product
              types you want to fill. 2. Fill in the cells from your spec
              sheets and save the file as CSV UTF-8. 3. Upload it here, check
              the preview, then apply.
            </s-text>
            <s-text color="subdued">
              A blank cell keeps the current value. Write [clear] to remove
              one. Hint columns are suggestions from the product's own
              options and title; copy one into its column to use it.
            </s-text>
            <LearnMore label="Formats and rules">
              <s-paragraph>
                Numbers are plain, with a dot or a comma for decimals (4.2 or
                4,2), without their unit, which is in the column's heading.
                Never a range. Yes or no cells take yes, no, true or false. A
                choice takes an option's code or its label; a multiple choice
                takes several separated by commas. Columns are matched by the
                key in brackets, then by name; other columns are listed and
                not read.
              </s-paragraph>
              <s-paragraph>
                {`A file holds up to ${limits.importRows.toLocaleString("en")} rows and ${limits.fileBytes / 1024 / 1024} MB. An export holds up to ${limits.exportRows.toLocaleString("en")} rows.`}
              </s-paragraph>
            </LearnMore>
          </s-stack>
        </s-section>

        <s-section id="values-export" heading="Export">
          {!catalogueRead ? (
            <s-text color="subdued">
              The catalogue has not been read yet. It is read every night.
            </s-text>
          ) : choices.length === 0 ? (
            <s-text color="subdued">
              No product has a product type in the plan yet.{" "}
              <s-link href={PRODUCT_SETUP_ROUTES.types}>Set up types</s-link>{" "}
              first.
            </s-text>
          ) : (
            <s-stack direction="block" gap="base">
              <s-choice-list
                label="Attributes"
                name="attributes"
                values={[preset]}
                onChange={(event) => {
                  const value = event.currentTarget.values[0];
                  if (value === "rig" || value === "all") setPreset(value);
                }}
              >
                <s-choice value="rig">
                  Rig essentials
                  <s-text slot="details">
                    The attributes the rig builder needs for each part.
                  </s-text>
                </s-choice>
                <s-choice value="all">
                  All attributes active for the type
                  <s-text slot="details">
                    Every attribute the plan gives the type that this page can
                    write.
                  </s-text>
                </s-choice>
              </s-choice-list>
              <s-stack direction="block" gap="small-400">
                <s-text type="strong">Product types</s-text>
                {choices.map((choice) => (
                  <s-checkbox
                    key={choice.typeId}
                    label={choice.label}
                    details={`${countOf(choice.products, "product")} · ${countOf(choice.variants, "variant")}`}
                    checked={selected.includes(choice.typeId)}
                    onChange={(event) =>
                      setSelected((now) =>
                        event.currentTarget.checked
                          ? [...now, choice.typeId]
                          : now.filter((id) => id !== choice.typeId),
                      )
                    }
                  />
                ))}
              </s-stack>
              <s-stack direction="inline" gap="base" alignItems="center">
                <DownloadButton
                  href={exportHref}
                  fallbackName="attribute-values.csv"
                  icon="export"
                  disabled={selected.length === 0 || tooMany}
                >
                  Export CSV
                </DownloadButton>
                <s-text color="subdued">
                  {selected.length === 0
                    ? "Choose at least one type."
                    : tooMany
                      ? `${rows.toLocaleString("en")} rows is more than the ${limits.exportRows.toLocaleString("en")} a file holds. Choose fewer types.`
                      : countOf(rows, "row")}
                </s-text>
              </s-stack>
            </s-stack>
          )}
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
