import { useMemo, useState } from "react";

import type { SourceSummary } from "~/domain/export-portal/contract";
import { Dropdown } from "~/web/components/dropdown";
import { ProcessHeader } from "~/web/components/process-header";
import { formatListDateTime } from "~/web/lib/datetime";
import {
  SOURCE_ROUTES,
  STATUS_FILTERS,
  describeRun,
  describeSchedule,
  filterSources,
  isRunActive,
  sourceStatus,
  type SourcesHeadline,
  type StatusFilter,
} from "~/web/lib/sources";

/**
 * The Sources page below its header (docs/sources.md § Screens): the
 * figures that answer "how is it going" at a glance, then every source as
 * one row a person can scan and act on.
 *
 * Healthy is calm (docs/ui-conventions.md § Setup state): the only figure
 * with a colour is the count of sources that need a person, and only when
 * it is not zero.
 */
const n = (value: number) => value.toLocaleString("en");

export function SourcesSummary({ headline }: { headline: SourcesHeadline }) {
  const cells: Array<{ label: string; value: string; warning?: boolean }> = [
    { label: "Sources", value: n(headline.total) },
    {
      label: "Needs attention",
      value: headline.attention > 0 ? n(headline.attention) : "None",
      warning: headline.attention > 0,
    },
    headline.active > 0
      ? { label: "Running now", value: n(headline.active) }
      : {
          label: "On",
          value: `${n(headline.enabled)} of ${n(headline.total)}`,
        },
  ];

  return (
    <s-section accessibilityLabel="Summary">
      <s-stack direction="block" gap="base">
        {headline.total > 0 ? (
          <ProcessHeader
            health={
              headline.attention > 0
                ? "needs_attention"
                : headline.enabled === 0
                  ? "off"
                  : headline.lastRunAt
                    ? "ok"
                    : "never_run"
            }
            lastRun={
              headline.lastRunAt ? { at: headline.lastRunAt, outcome: "" } : null
            }
            mode={headline.automatic ? "automatic" : "manual"}
            nextRunAt={headline.nextRunAt}
            running={headline.active > 0}
          />
        ) : null}
        <s-grid
          gridTemplateColumns="@container (inline-size <= 640px) 1fr 1fr, 1fr 1fr 1fr"
          gap="base"
        >
          {cells.map((cell) => (
            <s-stack key={cell.label} direction="block" gap="small-500">
              <s-text color="subdued">{cell.label}</s-text>
              <s-text type="strong" tone={cell.warning ? "caution" : "auto"}>
                {cell.value}
              </s-text>
            </s-stack>
          ))}
        </s-grid>
      </s-stack>
    </s-section>
  );
}

/** What the table lets a person do to one row. */
export interface SourceRowActions {
  run: (source: SourceSummary) => void;
  toggle: (source: SourceSummary) => void;
  /** Remembers which one; the page owns the dialog the button opens. */
  askDelete: (source: SourceSummary) => void;
  deleteModalId: string;
  busyWith: (intent: string, sourceId: string) => boolean;
  /** Any request is in flight, so nothing else may start. */
  busy: boolean;
}

export function SourcesTable({
  sources,
  refreshing,
  actions,
}: {
  sources: readonly SourceSummary[];
  /** The list is being read again; the rows stay put under a spinner. */
  refreshing: boolean;
  actions: SourceRowActions;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("");
  const [kind, setKind] = useState("");

  const kinds = useMemo(() => {
    const seen = new Map<string, string>();
    for (const source of sources) seen.set(source.kind, source.kindLabel);
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
  }, [sources]);

  const shown = useMemo(
    () => filterSources(sources, { query, status, kind }),
    [sources, query, status, kind],
  );
  const filtered = query.trim() !== "" || status !== "" || kind !== "";

  return (
    <s-section accessibilityLabel="Sources">
      <s-table variant="auto" {...(refreshing ? { loading: true } : {})}>
        {/*
         * Which sources, then which of those — the same reading order as
         * the admin's own index, where the view sits at the head of the
         * bar and the search runs to the end of it. The kind filter only
         * exists once there are two kinds to choose between.
         */}
        <s-grid
          slot="filters"
          gridTemplateColumns={
            kinds.length > 1
              ? "@container (inline-size <= 640px) 1fr, auto auto 1fr"
              : "@container (inline-size <= 640px) 1fr, auto 1fr"
          }
          gap="small-300"
          alignItems="center"
        >
          <s-box minInlineSize="170px">
            <Dropdown
              name="status"
              label="Status"
              hideLabel
              value={status}
              options={STATUS_FILTERS.map((f) => ({
                value: f.value,
                label: f.label,
              }))}
              onChange={(value) => setStatus(value as StatusFilter)}
            />
          </s-box>
          {kinds.length > 1 ? (
            <s-box minInlineSize="170px">
              <Dropdown
                name="kind"
                label="Kind"
                hideLabel
                value={kind}
                options={[{ value: "", label: "All kinds" }, ...kinds]}
                onChange={setKind}
              />
            </s-box>
          ) : null}
          <s-search-field
            label="Search sources"
            labelAccessibilityVisibility="exclusive"
            placeholder="Search by name, kind or destination"
            value={query}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </s-grid>

        <s-table-header-row>
          <s-table-header listSlot="primary">Source</s-table-header>
          <s-table-header listSlot="secondary">Status</s-table-header>
          <s-table-header listSlot="labeled">Schedule</s-table-header>
          <s-table-header listSlot="labeled">Last run</s-table-header>
          <s-table-header listSlot="labeled">Next run</s-table-header>
          <s-table-header listSlot="inline"></s-table-header>
        </s-table-header-row>

        <s-table-body>
          {shown.map((source) => (
            <SourceRow key={source.id} source={source} actions={actions} />
          ))}
        </s-table-body>
      </s-table>

      {shown.length === 0 && filtered ? (
        <s-box paddingBlock="large-100">
          <s-stack direction="block" gap="base" alignItems="center">
            <s-text color="subdued">No sources match these filters.</s-text>
            <s-button
              variant="secondary"
              onClick={() => {
                setQuery("");
                setStatus("");
                setKind("");
              }}
            >
              Clear filters
            </s-button>
          </s-stack>
        </s-box>
      ) : null}
    </s-section>
  );
}

function SourceRow({
  source,
  actions,
}: {
  source: SourceSummary;
  actions: SourceRowActions;
}) {
  const linkId = `open-${source.id}`;
  const menuId = `menu-${source.id}`;
  const status = sourceStatus(source);
  const running = isRunActive(source.lastRun);
  const schedule = describeSchedule(source.schedule);
  const last = source.lastRun;
  const lastAt = last?.finishedAt ?? last?.startedAt ?? last?.queuedAt ?? null;

  const cannotRun = actions.busy || running || !source.enabled;

  return (
    <s-table-row clickDelegate={linkId}>
      <s-table-cell>
        <s-stack direction="block" gap="small-500">
          {/* The name is the way in, and the whole row clicks it. */}
          <s-link id={linkId} href={SOURCE_ROUTES.source(source.id)}>
            {source.name}
          </s-link>
          <s-text color="subdued">
            {[source.kindLabel, source.destination].filter(Boolean).join(" → ")}
          </s-text>
        </s-stack>
      </s-table-cell>

      <s-table-cell>
        <s-badge {...(status.tone ? { tone: status.tone } : {})}>
          {status.label}
        </s-badge>
      </s-table-cell>

      <s-table-cell>
        <s-text {...(source.enabled ? {} : { color: "subdued" })}>
          {source.enabled ? schedule.summary : "Off"}
        </s-text>
      </s-table-cell>

      <s-table-cell>
        {last ? (
          <s-stack direction="block" gap="small-500">
            <s-text {...(last.status === "failed" ? { tone: "critical" } : {})}>
              {describeRun(last)}
            </s-text>
            {lastAt ? (
              <s-text color="subdued">{formatListDateTime(lastAt)}</s-text>
            ) : null}
          </s-stack>
        ) : (
          <s-text color="subdued">Never ran</s-text>
        )}
      </s-table-cell>

      <s-table-cell>
        {!source.enabled ? (
          <s-text color="subdued">—</s-text>
        ) : source.schedule.nextRunAt ? (
          <s-text>{formatListDateTime(source.schedule.nextRunAt)}</s-text>
        ) : schedule.mode === "automatic" ? (
          <s-text color="subdued">{schedule.summary}</s-text>
        ) : (
          <s-text color="subdued">When run by hand</s-text>
        )}
      </s-table-cell>

      <s-table-cell>
        {/*
         * The one thing a person does from the list is run a source; the
         * rest waits in a menu. Neither is the row's click target, so a
         * click on a button never opens the source.
         */}
        <s-stack
          direction="inline"
          gap="small-200"
          alignItems="center"
          justifyContent="end"
        >
          <s-button
            variant="secondary"
            accessibilityLabel={`Run ${source.name} now`}
            onClick={() => actions.run(source)}
            {...(cannotRun ? { disabled: true } : {})}
            {...(actions.busyWith("run", source.id) ? { loading: true } : {})}
          >
            Run now
          </s-button>
          <s-button
            icon="menu-horizontal"
            variant="tertiary"
            accessibilityLabel={`More actions for ${source.name}`}
            command="--show"
            commandFor={menuId}
            {...(actions.busy ? { disabled: true } : {})}
          />
          <s-menu id={menuId} accessibilityLabel={`Actions for ${source.name}`}>
            <s-button href={SOURCE_ROUTES.source(source.id)}>View</s-button>
            <s-button
              onClick={() => actions.toggle(source)}
              {...(running ? { disabled: true } : {})}
            >
              {source.enabled ? "Turn off" : "Turn on"}
            </s-button>
            <s-button
              tone="critical"
              command="--show"
              commandFor={actions.deleteModalId}
              onClick={() => actions.askDelete(source)}
            >
              Delete
            </s-button>
          </s-menu>
        </s-stack>
      </s-table-cell>
    </s-table-row>
  );
}
