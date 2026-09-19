import type { ReactNode } from "react";

import { DownloadButton } from "~/web/components/download-button";
import type { CampaignPhase } from "~/domain/sales/lifecycle";
import type { CampaignStatus, VariantState } from "~/domain/sales/types";
import { formatDateTime } from "~/web/lib/datetime";
import {
  PHASE_LABEL,
  SKIP_REASON_LABEL,
  STATUS_LABEL,
  formatInZone,
} from "~/web/lib/sales";

/**
 * The campaign editor's sidebar: where the campaign is, and what it comes
 * to (docs/sale-campaigns.md § UI).
 *
 * Two cards. Status says the one thing that changes on its own — draft,
 * scheduled, live with a progress line, needs attention — and carries the
 * action that moves it on, with the reason when that action is not
 * available. Summary reads the form back as numbers: how many products, how
 * many variants will actually change, from when to when, under which
 * policy. It follows the merchant's unsaved edits, so the answer to "what
 * will this do" is always beside the question.
 */

const n = (value: number) => value.toLocaleString("en");

export interface CampaignStatusProps {
  status: CampaignStatus;
  phase: CampaignPhase;
  run: {
    kind: string;
    status: string;
    done: number;
    failed: number;
    total: number;
  } | null;
  counts: Partial<Record<VariantState, number>>;
  startsAt: string | null;
  endsAt: string | null;
  timeZone: string;
  createdAt: string;
  createdBy: string | null;
  variantsHref: string;
  /** The button that moves the campaign on, when there is one. */
  action?: ReactNode;
  /** Why the action is not available right now, when it is not. */
  actionNote?: ReactNode;
  /**
   * The dialogs that decide every review row at once: put the recorded
   * originals back, or leave the variants at the price somebody else gave
   * them. Offered when the sale is over, where those are the only two
   * answers left; a live campaign still decides row by row.
   */
  reviewAll?: { restoreId: string; releaseId: string; busy: boolean };
}

export function CampaignStatus({
  status,
  phase,
  run,
  counts,
  startsAt,
  endsAt,
  timeZone,
  createdAt,
  createdBy,
  variantsHref,
  action,
  actionNote,
  reviewAll,
}: CampaignStatusProps) {
  const running = run?.status === "queued" || run?.status === "running";
  const failed = (counts.failed ?? 0) + (counts.restore_failed ?? 0);
  const onSale = (counts.applied ?? 0) + (counts.applying ?? 0);
  const review = counts.review ?? 0;

  const settled =
    status === "active" || status === "paused" || status === "completed"
      ? [
          onSale > 0 ? `${n(onSale)} on sale` : null,
          (counts.skipped ?? 0) > 0
            ? `${n(counts.skipped ?? 0)} skipped`
            : null,
          (counts.restored ?? 0) > 0
            ? `${n(counts.restored ?? 0)} restored`
            : null,
          (counts.released ?? 0) > 0
            ? `${n(counts.released ?? 0)} released`
            : null,
          failed > 0 ? `${n(failed)} failed` : null,
          review > 0 ? `${n(review)} need a decision` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : null;

  return (
    <s-section accessibilityLabel="Campaign status">
      <s-stack direction="block" gap="base">
        <s-stack direction="block" gap="small-300">
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-badge tone={status === "active" ? "success" : "neutral"}>
              {STATUS_LABEL[status]}
            </s-badge>
            {phase !== "idle" ? (
              <s-text color="subdued">{PHASE_LABEL[phase]}</s-text>
            ) : null}
          </s-stack>

          {running && run ? (
            <s-text>
              {`${run.kind === "restore" || run.kind === "release" ? "Putting prices back" : "Applying sale"}… ${n(run.done)} / ${n(run.total)} variants (${run.total > 0 ? Math.round((run.done / run.total) * 100) : 0}%)`}
            </s-text>
          ) : null}
          {settled !== null ? (
            <s-text color="subdued">{settled || "No variants yet."}</s-text>
          ) : null}
          {status === "active" ? (
            <s-text color="subdued">
              {endsAt
                ? `Ends ${formatInZone(endsAt, timeZone)}.`
                : "No end date. End it from here when the sale is over."}
            </s-text>
          ) : null}
          {status === "scheduled" && startsAt ? (
            <s-text color="subdued">{`Starts ${formatInZone(startsAt, timeZone)}.`}</s-text>
          ) : null}
          {status === "active" ? (
            <s-text color="subdued">
              Products, discount and policies are frozen while the sale is live.
              Pause to change them; pausing puts prices back first.
            </s-text>
          ) : null}
          <s-text color="subdued">
            {`Created ${formatDateTime(createdAt)}${createdBy ? ` · ${createdBy}` : ""}`}
          </s-text>
        </s-stack>

        {failed > 0 || review > 0 ? (
          <s-banner
            tone="critical"
            heading={
              failed > 0
                ? `${n(failed)} variants failed`
                : `${n(review)} variants need a decision`
            }
          >
            <s-paragraph>
              {failed > 0
                ? "Shopify rejected the write for these. The variants page shows its reason for each; fix it and retry."
                : reviewAll
                  ? "Their price was changed outside the campaign while it ran. Put the recorded originals back, leave them as they are now, or decide one by one."
                  : "Their price was changed outside the campaign. Decide for each on the variants page."}
            </s-paragraph>
            {failed === 0 && reviewAll ? (
              <s-stack direction="inline" gap="small-300">
                <s-button
                  command="--show"
                  commandFor={reviewAll.restoreId}
                  {...(reviewAll.busy ? { disabled: true } : {})}
                >
                  {`Put all ${n(review)} back`}
                </s-button>
                <s-button
                  command="--show"
                  commandFor={reviewAll.releaseId}
                  {...(reviewAll.busy ? { disabled: true } : {})}
                >
                  Leave them as they are
                </s-button>
              </s-stack>
            ) : null}
            <s-link href={variantsHref}>
              {failed === 0 && reviewAll
                ? "Decide one by one"
                : "Open variants"}
            </s-link>
          </s-banner>
        ) : null}

        {action || actionNote ? (
          <s-stack direction="block" gap="small-300">
            {action}
            {actionNote ? <s-text color="subdued">{actionNote}</s-text> : null}
          </s-stack>
        ) : null}
      </s-stack>
    </s-section>
  );
}

export interface SummaryCounts {
  products: number;
  variants: number;
  includedVariants: number;
  excludedVariants: number;
  /** Variants that would be written, taken-over ones included. */
  willChange: number;
  skipped: Record<string, number>;
}

export interface CampaignSummaryProps {
  /** "10% off", as the form now says it. */
  discount: string;
  counts: SummaryCounts | null;
  /** Counts are being worked out for the form as it now stands. */
  refreshing: boolean;
  /** Why the counts are not for the form as it now stands, when they are not. */
  note?: string | null;
  schedule: { starts: string; ends: string };
  conflicts: string;
  variantsHref: string;
  csvHref: string;
  /** Whether the variants page has anything to show yet. */
  hasVariants: boolean;
  /** Unsaved edits: the export would list the saved campaign, not this one. */
  dirty: boolean;
  snapshotAt: string | null;
  /** Shopify automatic discounts could not be checked, and why. */
  discountsUnchecked?: string | null;
}

function Row({
  label,
  value,
  strong,
  subdued,
}: {
  label: string;
  value: string;
  strong?: boolean;
  subdued?: boolean;
}) {
  return (
    <s-grid
      gridTemplateColumns="1fr auto"
      gap="small-300"
      alignItems="baseline"
    >
      <s-text color={subdued ? "subdued" : "base"}>{label}</s-text>
      <s-text
        type={strong ? "strong" : "generic"}
        color={subdued ? "subdued" : "base"}
        fontVariantNumeric="tabular-nums"
      >
        {value}
      </s-text>
    </s-grid>
  );
}

export function CampaignSummary({
  discount,
  counts,
  refreshing,
  note,
  schedule,
  conflicts,
  variantsHref,
  csvHref,
  hasVariants,
  dirty,
  snapshotAt,
  discountsUnchecked,
}: CampaignSummaryProps) {
  return (
    <s-section heading="Campaign summary">
      <s-stack direction="block" gap="base">
        <s-grid
          gridTemplateColumns="1fr auto"
          gap="small-300"
          alignItems="center"
        >
          <s-heading>{discount}</s-heading>
          {/* A fixed-size slot for the spinner, so the heading never moves. */}
          {refreshing ? (
            <s-spinner size="base" accessibilityLabel="Updating the summary" />
          ) : (
            <s-box inlineSize="20px" blockSize="20px" />
          )}
        </s-grid>

        <s-stack direction="block" gap="small-400">
          <Row label="Products" value={counts ? n(counts.products) : "—"} />
          <Row label="Variants" value={counts ? n(counts.variants) : "—"} />
          <Row
            label="Excluded"
            value={counts ? n(counts.excludedVariants) : "—"}
          />
          <Row
            label="Will change"
            value={counts ? n(counts.willChange) : "—"}
            strong
          />
          {counts
            ? Object.entries(counts.skipped)
                .filter(([, count]) => count > 0)
                .map(([reason, count]) => (
                  <Row
                    key={reason}
                    label={SKIP_REASON_LABEL[reason] ?? reason}
                    value={n(count)}
                    subdued
                  />
                ))
            : null}
        </s-stack>
        {note ? <s-text color="subdued">{note}</s-text> : null}

        <s-divider />

        <s-stack direction="block" gap="small-400">
          <Row label="Starts" value={schedule.starts} />
          <Row label="Ends" value={schedule.ends} />
          <Row label="Conflicts" value={conflicts} />
        </s-stack>

        {hasVariants ? (
          <s-stack direction="block" gap="small-300">
            {/* A matched pair: the same rows, on a page or in a file. */}
            <s-grid
              gridTemplateColumns="@container (inline-size <= 300px) 1fr, 1fr 1fr"
              gap="small-300"
            >
              <s-button
                href={variantsHref}
                icon="variant-list"
                inlineSize="fill"
                {...(dirty ? { disabled: true } : {})}
              >
                View variants
              </s-button>
              <DownloadButton
                href={csvHref}
                fallbackName="variants.csv"
                icon="export"
                inlineSize="fill"
                disabled={dirty}
              >
                Export CSV
              </DownloadButton>
            </s-grid>
            {dirty ? (
              <s-text color="subdued">
                Save first: the list and the export show the saved campaign.
              </s-text>
            ) : null}
          </s-stack>
        ) : null}

        {snapshotAt || discountsUnchecked ? (
          <s-stack direction="block" gap="small-500">
            {snapshotAt ? (
              <s-text color="subdued">
                {`From the catalogue read ${formatDateTime(snapshotAt)}. Previewing changes nothing.`}
              </s-text>
            ) : null}
            {discountsUnchecked ? (
              <s-text color="subdued">{`Shopify automatic discounts not checked: ${discountsUnchecked}`}</s-text>
            ) : null}
          </s-stack>
        ) : null}
      </s-stack>
    </s-section>
  );
}
