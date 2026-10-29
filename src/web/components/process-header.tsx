import { formatRelativeTime } from "~/web/lib/datetime";

/**
 * The one answer to "is this process healthy, when did it run, does it run by
 * itself, and when does it run next" (docs/ui-conventions.md § Page header).
 * Every page that owns a background process opens with it, so two pages
 * cannot answer differently.
 *
 * Healthy is calm: neutral text, no badge, no colour. A process that needs a
 * person is the loudest element on the page and carries the link to it.
 */
export type ProcessHealth = "ok" | "needs_attention" | "never_run" | "off";
export type ProcessMode = "automatic" | "manual";

export interface ProcessHeaderProps {
  health: ProcessHealth;
  lastRun?: { at: string; outcome: string } | null;
  mode: ProcessMode;
  /** Ignored for a manual or switched-off process: it has no next run. */
  nextRunAt?: string | null;
  /** A run is in progress right now. */
  running?: boolean;
  /** Where the person deals with it; shown when the process needs attention. */
  attention?: { href: string; label: string };
  /** What went wrong, in the process's own words; shown with the banner. */
  detail?: string | null;
}

const HEALTH_WORD: Record<ProcessHealth, string> = {
  ok: "Healthy",
  needs_attention: "Needs attention",
  never_run: "Never run",
  off: "Off",
};

const warned = new Set<string>();

/** A health value from outside the type needs attention, and is logged once. */
export function normalizeHealth(health: string): ProcessHealth {
  if (Object.hasOwn(HEALTH_WORD, health)) return health as ProcessHealth;
  if (!warned.has(health)) {
    warned.add(health);
    console.warn(
      `ProcessHeader: unknown health "${health}", showing Needs attention`,
    );
  }
  return "needs_attention";
}

/** The sentence, e.g. `Healthy · ran 2 min ago, completed · Automatic · next in 3 h`. */
export function describeProcess(
  props: ProcessHeaderProps,
  now: Date = new Date(),
): string {
  const health = normalizeHealth(props.health);
  const parts: string[] = [HEALTH_WORD[health]];
  if (props.running) parts.push("running now");
  if (props.lastRun) {
    const outcome = props.lastRun.outcome.trim();
    parts.push(
      `ran ${formatRelativeTime(props.lastRun.at, now)}${outcome ? `, ${outcome}` : ""}`,
    );
  } else if (health !== "never_run") {
    parts.push("no run recorded");
  }
  parts.push(props.mode === "manual" ? "Manual" : "Automatic");
  if (props.mode === "automatic" && health !== "off" && props.nextRunAt)
    parts.push(`next ${formatRelativeTime(props.nextRunAt, now)}`);
  return parts.join(" · ");
}

export function ProcessHeader(props: ProcessHeaderProps & { now?: Date }) {
  const text = describeProcess(props, props.now);
  if (normalizeHealth(props.health) === "needs_attention") {
    return (
      <s-banner tone="critical" heading={text}>
        {props.detail ? <s-paragraph>{props.detail}</s-paragraph> : null}
        {props.attention ? (
          <s-link href={props.attention.href}>{props.attention.label}</s-link>
        ) : null}
      </s-banner>
    );
  }
  return <s-text color="subdued">{text}</s-text>;
}
