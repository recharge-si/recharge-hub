import type { ReactNode } from "react";

import type { Run, Source } from "~/domain/export-portal/contract";
import { ProcessHeader } from "~/web/components/process-header";
import { formatDateTime, formatListDateTime } from "~/web/lib/datetime";
import {
  RUN_STATUS_LABEL,
  SOURCE_ROUTES,
  attentionItems,
  describeSchedule,
  isRunActive,
  isRunStale,
  runStatusLabel,
  runStatusTone,
  sourceProcess,
  sourceStatus,
} from "~/web/lib/sources";

/**
 * One source, read (docs/sources.md § Screens): the cards that say how it
 * is doing and what it is told to do. Nothing here is a control; every
 * card that can be changed carries one Edit button that opens the dialog
 * for that part, and the dialog is the page's.
 *
 * Healthy is calm (docs/ui-conventions.md § Setup state): the one colour
 * on the page is the source that needs a person, and the count of what it
 * needs is the loudest thing in the sidebar.
 */
const n = (value: number) => value.toLocaleString("en");

/** One card of the page. */
export function Card({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return <s-section accessibilityLabel={label}>{children}</s-section>;
}

/** A card's heading with the one action that changes what it states. */
export function CardHeading({
  heading,
  action,
}: {
  heading: string;
  action?: ReactNode;
}) {
  return (
    <s-grid gridTemplateColumns="1fr auto" gap="small-300" alignItems="center">
      <s-heading>{heading}</s-heading>
      {action ?? null}
    </s-grid>
  );
}

/** A label over its value, the cell every read-only card is made of. */
export function Fact({
  label,
  value,
  subdued = false,
  tone = "auto",
}: {
  label: string;
  value: ReactNode;
  subdued?: boolean;
  tone?: "auto" | "critical";
}) {
  return (
    <s-stack direction="block" gap="small-500">
      <s-text color="subdued">{label}</s-text>
      {typeof value === "string" ? (
        <s-text {...(subdued ? { color: "subdued" } : {})} tone={tone}>
          {value}
        </s-text>
      ) : (
        value
      )}
    </s-stack>
  );
}

/**
 * Facts in columns — three on a wide card, two on a narrow one. A track
 * list is spelt out rather than written with `repeat()`: a function in a
 * responsive value breaks Polaris's own tokeniser and leaves the grid a
 * single column.
 */
export function FactGrid({
  columns = 3,
  children,
}: {
  columns?: 2 | 3 | 4;
  children: ReactNode;
}) {
  const count = columns;
  const tracks = Array.from({ length: count }, () => "1fr").join(" ");
  return (
    <s-grid
      gridTemplateColumns={`@container (inline-size <= 480px) 1fr 1fr, ${tracks}`}
      gap="base"
      alignItems="start"
    >
      {children}
    </s-grid>
  );
}

/** One row of a `FactList`. */
export interface FactRow {
  key: string;
  label: string;
  /** What the setting does, under its name — the same whether read or edited. */
  help?: string | null;
  value: ReactNode;
  subdued?: boolean;
  /**
   * The value is the whole row — a switch, which carries its own name
   * beside its box rather than across the card from it.
   */
  wide?: boolean;
}

/**
 * Settings as rows of label and value, the way the admin states a
 * record: the label in a fixed column, the value beside it on the same
 * line, a rule between rows. Unlike columns of facts, a label that wraps
 * never pushes its value below its neighbours', and a long value has the
 * width to stay on one line. On a narrow card the label sits over the
 * value.
 */
export function FactList({ rows }: { rows: readonly FactRow[] }) {
  const described = rows.some((row) => row.help);
  return (
    <s-query-container>
      <s-stack direction="block" gap="small-200">
        {rows.map((row, index) => (
          <s-stack key={row.key} direction="block" gap="small-200">
            {index > 0 ? <s-divider /> : null}
            {row.wide ? (
              row.value
            ) : (
              <s-grid
                gridTemplateColumns="@container (inline-size <= 480px) 1fr, 'minmax(0, 16rem) minmax(0, 1fr)'"
                gap="small-500 base"
                alignItems="start"
              >
                {described ? (
                  // A list that explains its rows reads its names as names,
                  // with the explanation subdued under each.
                  <s-stack direction="block" gap="small-500">
                    <s-text>{row.label}</s-text>
                    {row.help ? (
                      <s-text color="subdued">{row.help}</s-text>
                    ) : null}
                  </s-stack>
                ) : (
                  <s-text color="subdued">{row.label}</s-text>
                )}
                {typeof row.value === "string" ? (
                  <s-text {...(row.subdued ? { color: "subdued" } : {})}>
                    {row.value}
                  </s-text>
                ) : (
                  row.value
                )}
              </s-grid>
            )}
          </s-stack>
        ))}
      </s-stack>
    </s-query-container>
  );
}

/**
 * The four figures that let someone understand the source in a glance:
 * the same four every page owning a background process answers
 * (docs/ui-conventions.md § Page header).
 */
export function SourceSummaryStrip({
  source,
  running,
}: {
  source: Source;
  running: boolean;
}) {
  const last = source.lastRun;
  const process = sourceProcess(source);

  return (
    <Card label="Summary">
      <s-stack direction="block" gap="base">
        <ProcessHeader
          {...process}
          running={running}
          attention={{
            href: SOURCE_ROUTES.runs(source.id),
            label: "See what the last run reported",
          }}
        />
        <Fact
          label="Items"
          value={
            last?.itemCount !== null && last?.itemCount !== undefined
              ? n(last.itemCount)
              : "\u2014"
          }
          subdued={last?.itemCount === null || last?.itemCount === undefined}
        />
      </s-stack>
    </Card>
  );
}

/**
 * The sidebar's one card about the source itself: on or off and how it
 * is doing, when it last worked, how it is scheduled and when it runs
 * next, when it was last changed. The schedule is the portal's — set
 * there for the catalogue or feed — so it is stated, not switched, and
 * the expression behind the words stays in the portal (docs/ui-
 * conventions.md § Element semantics: raw syntax never reaches a
 * merchant).
 */
export function StatusCard({
  source,
  runs,
  running,
}: {
  source: Source;
  runs: readonly Run[];
  running: boolean;
}) {
  const status = sourceStatus(source);
  const lastGood =
    runs.find((run) => run.status === "completed") ??
    (source.lastRun?.status === "completed" ? source.lastRun : null);
  const schedule = describeSchedule(source.schedule);

  return (
    <Card label="Status">
      <s-stack direction="block" gap="base">
        <Fact label="Source" value={source.enabled ? "On" : "Off"} />
        {source.enabled ? (
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-badge {...(status.tone ? { tone: status.tone } : {})}>
              {running ? "Running" : status.label}
            </s-badge>
          </s-stack>
        ) : null}
        <Fact
          label="Schedule"
          value={
            schedule.mode === "manual"
              ? "Manual — runs when started by hand"
              : schedule.summary
          }
        />
        <Fact
          label="Last successful run"
          value={
            lastGood?.finishedAt
              ? formatDateTime(lastGood.finishedAt)
              : lastGood?.startedAt
                ? formatDateTime(lastGood.startedAt)
                : "None yet"
          }
          subdued={!lastGood}
        />
        {source.updatedAt ? (
          <Fact label="Last changed" value={formatDateTime(source.updatedAt)} />
        ) : null}
      </s-stack>
    </Card>
  );
}

/**
 * What the last run reported, when the source needs a person. The
 * portal's line is laid out as figures when it is a tally, and shown as
 * it came otherwise; the run itself and the portal are where the detail
 * is, because nothing about these records is stored here.
 */
export function AttentionCard({ source }: { source: Source }) {
  if (source.health !== "needs_attention") return null;
  const last = source.lastRun;
  const items = attentionItems(last?.message);

  return (
    <Card label="Needs attention">
      <s-stack direction="block" gap="base">
        <CardHeading heading="Needs attention" />
        {items ? (
          <FactGrid columns={4}>
            {items.map((item) => (
              <Fact
                key={item.label}
                label={item.label}
                value={
                  <s-text type="strong" tone="caution">
                    {n(item.count)}
                  </s-text>
                }
              />
            ))}
          </FactGrid>
        ) : (
          <s-text tone="caution">
            {last?.message ??
              "The last run did not finish as it should. The run's log says what happened."}
          </s-text>
        )}
        <s-stack direction="inline" gap="base">
          {last ? (
            <s-link href={SOURCE_ROUTES.run(source.id, last.id)}>
              View the run
            </s-link>
          ) : null}
          {source.portalUrl ? (
            <s-link href={source.portalUrl} target="_blank">
              Open in export portal
            </s-link>
          ) : null}
        </s-stack>
      </s-stack>
    </Card>
  );
}

/** The latest few runs, and the way to the rest. */
export function RecentRuns({
  source,
  runs,
  limit = 5,
}: {
  source: Source;
  runs: readonly Run[];
  limit?: number;
}) {
  const shown = runs.slice(0, limit);
  return (
    <Card label="Recent runs">
      <s-stack direction="block" gap="base">
        <CardHeading
          heading="Recent runs"
          action={
            runs.length > 0 ? (
              <s-link href={SOURCE_ROUTES.runs(source.id)}>
                View all runs
              </s-link>
            ) : null
          }
        />
        {shown.length === 0 ? (
          <s-text color="subdued">No runs yet.</s-text>
        ) : (
          <RunsTable sourceId={source.id} runs={shown} />
        )}
      </s-stack>
    </Card>
  );
}

/** Runs as rows, shared by the source's page and its runs page. */
export function RunsTable({
  sourceId,
  runs,
}: {
  sourceId: string;
  runs: readonly Run[];
}) {
  return (
    <s-table variant="auto">
      <s-table-header-row>
        <s-table-header listSlot="primary">Started</s-table-header>
        <s-table-header listSlot="secondary">Status</s-table-header>
        <s-table-header format="numeric">Items</s-table-header>
        <s-table-header listSlot="labeled">Duration</s-table-header>
        <s-table-header listSlot="labeled">Note</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {runs.map((run) => (
          <s-table-row key={run.id} clickDelegate={`open-run-${run.id}`}>
            <s-table-cell>
              <s-link
                id={`open-run-${run.id}`}
                href={SOURCE_ROUTES.run(sourceId, run.id)}
              >
                {run.startedAt
                  ? formatListDateTime(run.startedAt)
                  : run.queuedAt
                    ? `Queued ${formatListDateTime(run.queuedAt)}`
                    : "Queued"}
              </s-link>
            </s-table-cell>
            <s-table-cell>
              <s-badge
                {...(isRunStale(run)
                  ? { tone: "warning" as const }
                  : runStatusTone(run.status)
                    ? { tone: runStatusTone(run.status) }
                    : {})}
              >
                {runStatusLabel(run)}
              </s-badge>
            </s-table-cell>
            <s-table-cell>
              <s-text>
                {run.itemCount === null || run.itemCount === undefined
                  ? "—"
                  : n(run.itemCount)}
              </s-text>
            </s-table-cell>
            <s-table-cell>
              <s-text color="subdued">{describeDuration(run)}</s-text>
            </s-table-cell>
            <s-table-cell>
              <s-text
                {...(run.status === "failed"
                  ? { tone: "critical" }
                  : { color: "subdued" })}
              >
                {run.message ??
                  (run.triggeredBy ? `By ${run.triggeredBy}` : "")}
              </s-text>
            </s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}

/** "4 min 12 s", "Running", or the finish time when the start is unknown. */
function describeDuration(run: Run): string {
  if (isRunActive(run)) return RUN_STATUS_LABEL[run.status];
  if (isRunStale(run)) return "Stopped responding";
  if (!run.finishedAt) return "—";
  if (!run.startedAt) return formatListDateTime(run.finishedAt);
  const seconds = Math.max(
    0,
    Math.round(
      (new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) /
        1000,
    ),
  );
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}
