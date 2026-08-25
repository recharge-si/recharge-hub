/**
 * The line at the top of every page that owns a background process.
 *
 * `docs/ui-conventions.md` fixes what it answers and requires the same
 * component everywhere, so that two pages cannot answer it differently:
 * healthy or needs attention, when it last ran and how it went, whether it runs
 * on its own or only when asked, and when it runs next.
 *
 * Colour marks exceptions only, so a working process gets no green badge — it
 * gets a plain sentence. The badge appears only when something needs doing, and
 * then it is the loudest thing on the line and carries the way to fix it.
 *
 * Everything stacks. A merchant reading this on a phone gets four short lines
 * rather than four columns, and nothing here is wide enough to scroll sideways.
 */

export interface SyncStatusProps {
  /** What this process is, in the merchant's words: "Product sync". */
  title: string;
  healthy: boolean;
  /** One sentence saying what is wrong. Required when not healthy. */
  problem?: string;
  /** ISO timestamp of the last run, or null when it has never run. */
  lastRunAt: string | null;
  /** How the last run went, in a few words: "12 renamed, 3 created". */
  outcome?: string | null;
  /**
   * When it runs next, in plain words. "Runs when you press Sync products" is
   * a complete and honest answer for something that has no schedule, and the
   * merchant needs to know that far more than they need a timestamp.
   */
  cadence: string;
  /** Where to go about the problem. Only meaningful when not healthy. */
  action?: { label: string; href: string };
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function SyncStatus({
  title,
  healthy,
  problem,
  lastRunAt,
  outcome,
  cadence,
  action,
}: SyncStatusProps) {
  return (
    <s-box padding="base" background="subdued" borderRadius="base">
      <s-stack direction="block" gap="small-400">
        <s-stack direction="inline" gap="small-300" alignItems="center">
          <s-text type="strong">{title}</s-text>
          {healthy ? (
            <s-text color="subdued">Working</s-text>
          ) : (
            <s-badge tone="critical">Needs attention</s-badge>
          )}
        </s-stack>

        {!healthy && problem ? <s-text>{problem}</s-text> : null}

        <s-text color="subdued">
          {lastRunAt
            ? `Last run ${formatDateTime(lastRunAt)}${outcome ? ` — ${outcome}` : ""}.`
            : "Has not run yet."}
        </s-text>

        <s-text color="subdued">{cadence}</s-text>

        {!healthy && action ? (
          <s-link href={action.href}>{action.label}</s-link>
        ) : null}
      </s-stack>
    </s-box>
  );
}
