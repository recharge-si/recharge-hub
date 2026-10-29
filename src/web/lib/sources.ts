import type {
  Field,
  FieldValues,
  Run,
  RunStatus,
  Schedule,
  SourceHealth,
  SourceSummary,
} from "~/domain/export-portal/contract";
import { isOn } from "~/domain/export-portal/fields";

/**
 * Words and addresses for the Sources pages (docs/sources.md § Screens).
 * Client-safe: labels and formatting only.
 *
 * A **source** is one product source the export portal pushes into this
 * store — a catalogue export or a brand feed, stocked at one location, with
 * its own settings. A **run** is one push. Both words are the portal's, and
 * they are used unchanged so a person moving between the two admins reads
 * the same thing.
 */

export const SOURCE_ROUTES = {
  index: "/app/sources",
  new: "/app/sources/new",
  connection: "/app/sources/connection",
  /** Which sources' new products the AI sorts into product types (§ AI categorization per source). */
  categorization: "/app/sources/categorization",
  /** New products waiting for a person before they go live (§ Review before publish). */
  review: (sourceId?: string | null) =>
    sourceId
      ? `/app/sources/review?source=${encodeURIComponent(sourceId)}`
      : "/app/sources/review",
  source: (id: string) => `/app/sources/${encodeURIComponent(id)}`,
  runs: (id: string) => `/app/sources/${encodeURIComponent(id)}/runs`,
  run: (sourceId: string, runId: string) =>
    `/app/sources/${encodeURIComponent(sourceId)}/runs/${encodeURIComponent(runId)}`,
} as const;

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function runStatusTone(
  status: RunStatus,
): "info" | "critical" | "neutral" | undefined {
  switch (status) {
    case "queued":
    case "running":
      return "info";
    case "failed":
      return "critical";
    case "cancelled":
      return "neutral";
    case "completed":
      return undefined;
  }
}

export const HEALTH_LABEL: Record<SourceHealth, string> = {
  ok: "Working",
  needs_attention: "Needs attention",
  never_ran: "Never ran",
  off: "Off",
};

/**
 * Needs attention is a warning, not a failure: the source is configured
 * and running, and what it reports is a list of things to look at. Red
 * is kept for a run that failed.
 */
export function healthTone(
  health: SourceHealth,
): "warning" | "neutral" | undefined {
  if (health === "needs_attention") return "warning";
  if (health === "off" || health === "never_ran") return "neutral";
  return undefined;
}

/**
 * A schedule as a list reads it, and the technical part kept aside.
 *
 * The portal describes a schedule in words, and sometimes ends the words
 * with the expression behind them: "After each catalogue refresh
 * (26 * * * *)". The words are what a table shows; the expression is a
 * detail for the source's own page (docs/ui-conventions.md § Element
 * semantics: raw syntax never reaches a merchant outside the field it is
 * edited in). Only a trailing parenthesis that looks like a cron
 * expression — five or six fields of digits and cron punctuation — is
 * split off; any other parenthesis is part of the sentence.
 */
export interface ScheduleView {
  mode: Schedule["mode"];
  /** "After each catalogue refresh", "Every day at 04:00", "Manual". */
  summary: string;
  /** The expression the portal appended, when it did. */
  technical: string | null;
}

const CRON_FIELD = /^[\d*/,\-?LW#]+$/;

function splitTechnical(description: string): {
  words: string;
  technical: string | null;
} {
  const match = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(description);
  if (!match) return { words: description.trim(), technical: null };
  const inner = match[2]!.trim();
  const parts = inner.split(/\s+/);
  const looksLikeCron =
    (parts.length === 5 || parts.length === 6) &&
    parts.every((part) => CRON_FIELD.test(part));
  if (!looksLikeCron || match[1]!.trim() === "")
    return { words: description.trim(), technical: null };
  return { words: match[1]!.trim(), technical: inner };
}

export function describeSchedule(schedule: Schedule): ScheduleView {
  if (schedule.mode === "manual")
    return { mode: "manual", summary: "Manual", technical: null };
  if (!schedule.description)
    return { mode: "automatic", summary: "Automatic", technical: null };
  const { words, technical } = splitTechnical(schedule.description);
  return { mode: "automatic", summary: words || "Automatic", technical };
}

/**
 * One status for a source, combining the three things the portal says
 * separately — on or off, healthy or not, running now — into the one badge
 * a list shows. Running wins, because it is what is happening; off wins
 * over health, because a source that is off cannot need anything.
 */
export interface SourceStatus {
  label: string;
  tone: "info" | "warning" | "neutral" | undefined;
}

export function sourceStatus(
  source: Pick<SourceSummary, "enabled" | "health" | "lastRun">,
): SourceStatus {
  if (isRunActive(source.lastRun)) return { label: "Running", tone: "info" };
  if (isRunStale(source.lastRun))
    return { label: "Stopped responding", tone: "warning" };
  if (!source.enabled) return { label: "Off", tone: "neutral" };
  return {
    label: HEALTH_LABEL[source.health],
    tone: healthTone(source.health),
  };
}

/**
 * What the portal said about the last run, read as counts when it is a
 * list of them.
 *
 * A run's `message` is one line in the portal's words. When those words
 * are a tally — "4581 stock · 324 content · 3 images · 1 unmatched" — a
 * screen can lay them out as figures rather than a sentence. This reads
 * only the form of the line, never what a word means: a message that is
 * not a tally comes back as null and is shown as it came.
 */
export interface AttentionItem {
  count: number;
  label: string;
}

export function attentionItems(
  message: string | null | undefined,
): AttentionItem[] | null {
  if (!message) return null;
  const parts = message.split(/\s*[·•|]\s*|,\s+/);
  if (parts.length < 2) return null;
  const items: AttentionItem[] = [];
  for (const part of parts) {
    const match = /^(\d[\d,.]*)\s+([^\d].*)$/.exec(part.trim());
    if (!match) return null;
    const count = Number(match[1]!.replace(/[,.]/g, ""));
    if (!Number.isFinite(count)) return null;
    items.push({ count, label: match[2]!.trim() });
  }
  return items;
}

/**
 * An option's name without its explanation. The portal labels a choice
 * "Portal authoritative — the portal maintains every synced field": the
 * explanation belongs in the editor, beside the other choices; a card
 * stating what is chosen needs only the name.
 */
export function shortLabel(label: string): string {
  return label.split(/\s+[—–]\s+/)[0]!.trim() || label;
}

/** A field's stored value, as a read-only card states it. */
export interface FieldDisplay {
  text: string;
  /** False when nothing is stored, so the card can subdue it. */
  set: boolean;
}

export function displayFieldValue(
  field: Field,
  values: FieldValues,
): FieldDisplay {
  const value = values[field.key];
  if (field.type === "boolean")
    return { text: isOn(field, values) ? "On" : "Off", set: true };
  if (value === null || value === undefined || value === "")
    return { text: "Not set", set: false };
  if (field.type === "select") {
    const option = (field.options ?? []).find((o) => o.value === String(value));
    return { text: shortLabel(option?.label ?? String(value)), set: true };
  }
  if (field.type === "secret") {
    // The portal answers with a mask, never the value.
    return { text: typeof value === "string" ? value : "Saved", set: true };
  }
  return { text: String(value), set: true };
}

/** The list's filters, all client-side: the portal answers with every source at once. */
export const STATUS_FILTERS = [
  { value: "", label: "All statuses" },
  { value: "needs_attention", label: "Needs attention" },
  { value: "running", label: "Running" },
  { value: "ok", label: "Working" },
  { value: "never_ran", label: "Never ran" },
  { value: "off", label: "Off" },
] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number]["value"];

export interface SourceFilters {
  query: string;
  status: StatusFilter;
  kind: string;
}

export function filterSources(
  sources: readonly SourceSummary[],
  filters: SourceFilters,
): SourceSummary[] {
  const query = filters.query.trim().toLowerCase();
  return sources.filter((source) => {
    if (filters.kind && source.kind !== filters.kind) return false;
    if (filters.status) {
      const running = isRunActive(source.lastRun);
      switch (filters.status) {
        case "running":
          if (!running) return false;
          break;
        case "off":
          if (running || source.enabled) return false;
          break;
        default:
          if (running || !source.enabled || source.health !== filters.status)
            return false;
      }
    }
    if (query) {
      const haystack = [source.name, source.kindLabel, source.destination ?? ""]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

/** A run's status in words; a run that died unfinished says so. */
export function runStatusLabel(
  run: Pick<Run, "status" | "startedAt" | "queuedAt">,
): string {
  return isRunStale(run) ? "Stopped responding" : RUN_STATUS_LABEL[run.status];
}

/** One line about the last run: its outcome and what it carried. */
export function describeRun(run: Run | null | undefined): string {
  if (!run) return "Never ran";
  const parts: string[] = [runStatusLabel(run)];
  if (run.itemCount !== null && run.itemCount !== undefined) {
    parts.push(
      `${run.itemCount.toLocaleString("en")} ${run.itemCount === 1 ? "item" : "items"}`,
    );
  }
  return parts.join(" · ");
}

/** A run is still going, so the page keeps asking. */
/**
 * No real run lasts this long: every Shopify call the portal makes times out
 * in seconds. A run still queued or running after it died with the portal
 * process (a deploy or a crash), and the portal only closes it when it next
 * starts or the store's next run begins.
 */
export const RUN_STALE_MS = 6 * 60 * 60 * 1000;

/** Said as queued or running, but too old to be either. */
export function isRunStale(
  run: Pick<Run, "status" | "startedAt" | "queuedAt"> | null | undefined,
  now: number = Date.now(),
): boolean {
  if (run?.status !== "queued" && run?.status !== "running") return false;
  const since = run.startedAt ?? run.queuedAt;
  if (!since) return false;
  const at = new Date(since).getTime();
  return Number.isFinite(at) && now - at > RUN_STALE_MS;
}

/**
 * Queued or running, and young enough to be true. A stale run is not active:
 * the page stops waiting for it and Run now is offered again, which is also
 * what makes the portal close the dead run.
 */
export function isRunActive(
  run: Pick<Run, "status" | "startedAt" | "queuedAt"> | null | undefined,
  now: number = Date.now(),
): boolean {
  return (
    (run?.status === "queued" || run?.status === "running") &&
    !isRunStale(run, now)
  );
}

/** What the header of the Sources page says about all of them at once. */
export interface SourcesHeadline {
  tone: "healthy" | "needs_attention" | "empty";
  /** Some enabled source runs on a schedule rather than by hand. */
  automatic: boolean;
  summary: string;
  total: number;
  attention: number;
  enabled: number;
  /** The most recent finished run across every source, when there is one. */
  lastRunAt: string | null;
  nextRunAt: string | null;
  active: number;
}

export function summarizeSources(
  sources: readonly SourceSummary[],
): SourcesHeadline {
  if (sources.length === 0) {
    return {
      tone: "empty",
      summary: "No sources yet.",
      automatic: false,
      total: 0,
      attention: 0,
      enabled: 0,
      lastRunAt: null,
      nextRunAt: null,
      active: 0,
    };
  }

  const attention = sources.filter((s) => s.health === "needs_attention");
  const enabled = sources.filter((s) => s.enabled);
  const active = sources.filter((s) => isRunActive(s.lastRun)).length;
  const automatic = enabled.some((s) => s.schedule.mode === "automatic");

  let lastRunAt: string | null = null;
  let nextRunAt: string | null = null;
  for (const source of sources) {
    const finished = source.lastRun?.finishedAt ?? null;
    if (finished && (!lastRunAt || finished > lastRunAt)) lastRunAt = finished;
    const next = source.enabled ? (source.schedule.nextRunAt ?? null) : null;
    if (next && (!nextRunAt || next < nextRunAt)) nextRunAt = next;
  }

  if (attention.length > 0) {
    return {
      tone: "needs_attention",
      summary: `${attention.length} of ${sources.length} ${sources.length === 1 ? "source needs" : "sources need"} attention.`,
      automatic,
      total: sources.length,
      attention: attention.length,
      enabled: enabled.length,
      lastRunAt,
      nextRunAt,
      active,
    };
  }

  return {
    tone: "healthy",
    summary: `${enabled.length} of ${sources.length} ${sources.length === 1 ? "source is" : "sources are"} on.`,
    automatic,
    total: sources.length,
    attention: 0,
    enabled: enabled.length,
    lastRunAt,
    nextRunAt,
    active,
  };
}

/**
 * What the source page's action answers, for the page and each of its
 * dialogs. `fieldErrors` is keyed by a field's `key` (or `name`), so a
 * refusal lands under the input it names.
 */
export interface SourceActionResult {
  ok: boolean;
  intent: "save" | "toggle" | "run" | "delete";
  message: string;
  fieldErrors?: Record<string, string>;
}

/**
 * The switch that turns a whole group on or off, when a group has one.
 *
 * The portal does not say which field depends on which; this app knows
 * a field's type, never its meaning. What it can read is the shape of a
 * group: one that opens with a switch and goes on to inputs — "Round
 * shelf prices", then direction, step and ending — is a feature and its
 * settings, and with the feature off the settings are noise. A group
 * that is switches throughout — four sales channels — has no such
 * leader, and each stands alone.
 */
export function leadingSwitch(fields: readonly Field[]): Field | null {
  const first = fields[0];
  if (!first || first.type !== "boolean") return null;
  const rest = fields.slice(1);
  return rest.some((field) => field.type !== "boolean") ? first : null;
}

/**
 * The four answers every process header gives, for one source: healthy or
 * not, how its last run went, whether it runs by itself, and when next.
 * Structurally a `ProcessHeaderProps` (components/process-header).
 */
export function sourceProcess(source: SourceSummary): {
  health: "ok" | "needs_attention" | "never_run" | "off";
  lastRun: { at: string; outcome: string } | null;
  mode: "automatic" | "manual";
  nextRunAt: string | null;
  running: boolean;
} {
  const run = source.lastRun;
  const at = run?.finishedAt ?? run?.startedAt ?? run?.queuedAt ?? null;
  const health = isRunStale(run)
    ? "needs_attention"
    : !source.enabled
      ? "off"
      : source.health === "needs_attention"
        ? "needs_attention"
        : source.health === "never_ran"
          ? "never_run"
          : source.health === "off"
            ? "off"
            : "ok";
  return {
    health,
    lastRun: run && at ? { at, outcome: runStatusLabel(run).toLowerCase() } : null,
    mode: describeSchedule(source.schedule).mode,
    nextRunAt: source.schedule.nextRunAt ?? null,
    running: isRunActive(run),
  };
}
