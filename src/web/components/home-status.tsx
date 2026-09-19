import type { ReadinessComponent } from "~/domain/readiness";

/**
 * The home page's status card: one row per part of the integration, saying
 * what it is doing and when it last did it.
 *
 * Healthy is calm (docs/ui-conventions.md § Setup state): a working row is
 * a sentence and a time, the one that needs a person carries the only badge
 * and the only button, and a part the merchant switched off says "Off" and
 * nothing else — no timestamp for a job that does not run, no count for a
 * thing that is not counted.
 */
export interface StatusRow {
  key: string;
  title: string;
  status: ReadinessComponent["status"] | "info";
  /** What it is, in one line: "Connected to company 6789", "2 campaigns live". */
  summary: string;
  /** When it last ran, or what it last did, when that is a thing it does. */
  lastRun?: { text: string; failed?: boolean } | null;
  action?: { label: string; href: string } | null;
}

export function HomeStatus({ rows }: { rows: StatusRow[] }) {
  return (
    <s-section heading="Status">
      <s-stack direction="block" gap="base">
        {rows.map((row) => (
          <s-stack key={row.key} direction="block" gap="small-500">
            <s-grid
              gridTemplateColumns="1fr auto"
              gap="small-300"
              alignItems="center"
            >
              <s-text type="strong">{row.title}</s-text>
              {row.status === "needs_attention" ? (
                <s-badge tone="critical">Needs attention</s-badge>
              ) : row.status === "disabled" ? (
                <s-text color="subdued">Off</s-text>
              ) : null}
            </s-grid>
            <s-text
              color="subdued"
              tone={row.status === "needs_attention" ? "critical" : "auto"}
            >
              {row.summary}
            </s-text>
            {row.lastRun ? (
              <s-text
                color="subdued"
                tone={row.lastRun.failed ? "caution" : "auto"}
              >
                {row.lastRun.text}
              </s-text>
            ) : null}
            {row.status === "needs_attention" && row.action ? (
              <s-stack direction="inline">
                <s-button variant="secondary" href={row.action.href}>
                  {row.action.label}
                </s-button>
              </s-stack>
            ) : null}
          </s-stack>
        ))}
      </s-stack>
    </s-section>
  );
}
