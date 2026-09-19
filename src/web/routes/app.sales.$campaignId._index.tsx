import { boundary } from "@shopify/shopify-app-react-router/server";
import { useCallback, useEffect, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  useRevalidator,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import {
  catalogueFacets,
  getCatalogueState,
} from "~/adapters/db/repositories/catalogue.server";
import { eventsForEntity } from "~/adapters/db/repositories/event-log.server";
import {
  countVariantStates,
  deleteCampaign,
  getCampaign,
  latestRun,
  updateCampaign,
} from "~/adapters/db/repositories/sale-campaign.server";
import { enqueueThrottled } from "~/adapters/queue/boss.server";
import { QUEUES, catalogueSnapshotKey } from "~/adapters/queue/queues";
import { recordCampaignEvent } from "~/adapters/sales/events.server";
import {
  activateCampaign,
  cancelCampaign,
  endCampaign,
  pauseCampaign,
  retryFailedVariants,
  scheduleCampaign,
  unscheduleCampaign,
} from "~/adapters/sales/lifecycle.server";
import { listMetafieldDefinitions } from "~/adapters/shopify/products";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { editability, phaseFor } from "~/domain/sales/lifecycle";
import { parseRuleGroup, type RuleGroup } from "~/domain/sales/rules";
import { AdvancedSection } from "~/web/components/advanced-section";
import { Dropdown } from "~/web/components/dropdown";
import { RuleBuilder } from "~/web/components/rule-builder";
import { formatDateTime } from "~/web/lib/datetime";
import { formatMoney } from "~/web/lib/money";
import {
  actorFromSession,
  principalFromSession,
} from "~/web/lib/principal.server";
import { redirectWithin } from "~/web/lib/redirects";
import {
  BASE_CHANGE_LABEL,
  CONFLICT_LABEL,
  DISCOUNT_TYPE_LABEL,
  EXISTING_SALE_LABEL,
  PHASE_LABEL,
  ROUNDING_LABEL,
  SKIP_REASON_LABEL,
  STATUS_LABEL,
  describeDiscount,
  formatAmountInput,
  formatBasisPoints,
  formatInZone,
  utcToZoned,
} from "~/web/lib/sales";
import {
  buildPreview,
  campaignFormSchema,
  parseCampaignForm,
  type CampaignForm,
} from "~/web/lib/sales.server";
import { useResetWhenSaved, useSaveBar } from "~/web/lib/use-save-bar";

/**
 * The campaign editor (docs/sale-campaigns.md § UI).
 *
 * General · Targeting · Exclusions · Discount · Schedule · Conflict handling
 * · Advanced · Preview, then the campaign's own trail. The header carries
 * the lifecycle actions the current status allows. Everything the merchant
 * edits is saved as a draft of settings; nothing in Shopify changes until
 * Activate, and Activate goes through a confirmation naming the count.
 *
 * The preview is computed on load from the catalogue snapshot and writes
 * nothing (docs/ui-conventions.md § Destructive writes).
 */
const SAVE_BAR_ID = "sale-campaign-save-bar";
const CONFIRM_MODAL_ID = "confirm-activate";
const HELP_MODAL_ID = "about-campaign";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const id = String(params.campaignId ?? "");

  const campaign = await getCampaign(principal, id);
  if (!campaign) throw new Response("Not found", { status: 404 });

  const [catalogue, facets, metafields, counts, run, events] =
    await Promise.all([
      getCatalogueState(principal),
      catalogueFacets(principal),
      listMetafieldDefinitions(admin).catch(() => []),
      countVariantStates(campaign.id),
      latestRun(campaign.id),
      eventsForEntity(principal, "sale_campaign", campaign.id, 30),
    ]);
  const timeZone = catalogue.ianaTimezone ?? "UTC";

  const previewable =
    campaign.status === "draft" ||
    campaign.status === "scheduled" ||
    campaign.status === "paused";
  const preview =
    previewable && catalogue.snapshotAt
      ? await buildPreview(principal, campaign, admin)
      : null;

  const inProgress =
    run && (run.status === "queued" || run.status === "running")
      ? run.kind === "restore" || run.kind === "release"
        ? ("restore" as const)
        : ("apply" as const)
      : null;

  const starts = campaign.startsAt
    ? utcToZoned(campaign.startsAt, timeZone)
    : null;
  const ends = campaign.endsAt ? utcToZoned(campaign.endsAt, timeZone) : null;

  const form: CampaignForm = {
    name: campaign.name,
    notes: campaign.notes ?? "",
    discountType: campaign.discountType,
    discountValue:
      campaign.discountType === "percentage"
        ? formatBasisPoints(campaign.discountValue).replace("%", "")
        : formatAmountInput(campaign.discountValue),
    rounding: campaign.rounding,
    roundingIncrement: formatAmountInput(campaign.roundingIncrementMinor),
    startMode: campaign.startsAt && campaign.status !== "active" ? "at" : "now",
    startDate: starts?.date ?? "",
    startTime: starts?.time ?? "00:00",
    endMode: campaign.endsAt ? "at" : "none",
    endDate: ends?.date ?? "",
    endTime: ends?.time ?? "23:59",
    priority: String(campaign.priority),
    existingSalePolicy: campaign.existingSalePolicy,
    conflictStrategy: campaign.conflictStrategy,
    basePriceChangePolicy: campaign.basePriceChangePolicy,
    dynamicMembership: campaign.dynamicMembership ? "on" : "off",
    includeRules: JSON.stringify(parseRuleGroup(campaign.includeRules)),
    excludeRules: JSON.stringify(parseRuleGroup(campaign.excludeRules)),
  };

  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      currency: campaign.currency,
      discount: describeDiscount(
        { type: campaign.discountType, value: campaign.discountValue },
        campaign.currency,
      ),
      startsAt: campaign.startsAt?.toISOString() ?? null,
      endsAt: campaign.endsAt?.toISOString() ?? null,
      createdBy: campaign.createdBy,
      createdAt: campaign.createdAt.toISOString(),
      editability: editability(campaign.status),
      phase: phaseFor(campaign.status, counts, inProgress),
    },
    form,
    timeZone,
    facets,
    metafields,
    counts,
    run: run
      ? {
          kind: run.kind,
          status: run.status,
          done: run.done,
          failed: run.failed,
          total: run.total,
        }
      : null,
    preview,
    catalogue: {
      snapshotAt: catalogue.snapshotAt?.toISOString() ?? null,
      reading: catalogue.bulkOperationId !== null,
    },
    events: events.map((event) => ({
      id: event.id,
      at: event.at.toISOString(),
      event: event.event,
      detail: event.detail,
    })),
  };
};

type ActionResult = { ok: boolean; message: string; field?: string };

export const action = async ({
  request,
  params,
}: ActionFunctionArgs): Promise<ActionResult> => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const id = String(params.campaignId ?? "");
  const actor = actorFromSession(session);
  const now = new Date();

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  const campaign = await getCampaign(principal, id);
  if (!campaign) return { ok: false, message: "Campaign not found." };

  if (intent === "save") {
    const raw: Record<string, string> = {};
    for (const [key, value] of formData.entries()) {
      if (typeof value === "string") raw[key] = value;
    }
    const parsedForm = campaignFormSchema.safeParse(raw);
    if (!parsedForm.success) {
      return {
        ok: false,
        message: "The form could not be read. Reload the page and try again.",
      };
    }
    const catalogue = await getCatalogueState(principal);
    const outcome = parseCampaignForm(parsedForm.data, {
      timeZone: catalogue.ianaTimezone ?? "UTC",
      currency: campaign.currency,
      now,
    });
    if (!outcome.ok)
      return { ok: false, field: outcome.field, message: outcome.message };

    const allowed = editability(campaign.status);
    if (allowed === "none") {
      return {
        ok: false,
        message: `A ${campaign.status} campaign cannot be edited.`,
      };
    }
    const patch =
      allowed === "full"
        ? outcome.input
        : {
            name: outcome.input.name,
            notes: outcome.input.notes,
            endsAt: outcome.input.endsAt,
          };
    await updateCampaign(principal, campaign.id, patch);
    await recordCampaignEvent(principal, campaign.id, "sale_campaign.edited", {
      by: actor,
      fields: Object.keys(patch),
    });
    return { ok: true, message: "Saved." };
  }

  if (intent === "delete") {
    await recordCampaignEvent(principal, campaign.id, "sale_campaign.deleted", {
      by: actor,
      status: campaign.status,
    });
    const deleted = await deleteCampaign(principal, campaign.id);
    if (!deleted)
      return {
        ok: false,
        message:
          "Only a draft that has never been applied, or a finished campaign with every price back, can be deleted.",
      };
    throw redirectWithin(request, "/app/sales");
  }

  if (intent === "refresh-catalogue") {
    const jobId = await enqueueThrottled(
      QUEUES.catalogueSnapshot,
      { shopDomain: principal.shopDomain },
      catalogueSnapshotKey(principal.shopDomain),
      60,
    );
    return {
      ok: true,
      message: jobId
        ? "Reading the catalogue from Shopify. The preview updates when it finishes."
        : "The catalogue is already being read.",
    };
  }

  const options = { now, requestedBy: actor };
  switch (intent) {
    case "activate":
      return activateCampaign(principal, campaign.id, options);
    case "schedule":
      return scheduleCampaign(principal, campaign.id, now);
    case "unschedule":
      return unscheduleCampaign(principal, campaign.id, now);
    case "pause":
      return pauseCampaign(principal, campaign.id, options);
    case "end":
      return endCampaign(principal, campaign.id, {
        ...options,
        reason: "end_now",
      });
    case "restore":
      return endCampaign(principal, campaign.id, {
        ...options,
        reason: "restore",
      });
    case "cancel":
      return cancelCampaign(principal, campaign.id, options);
    case "retry":
      return retryFailedVariants(principal, campaign.id, options);
    default:
      return { ok: false, message: "Unknown action." };
  }
};

function usePolling(active: boolean) {
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") void revalidator.revalidate();
    }, 3000);
    return () => clearInterval(timer);
  }, [active, revalidator]);
}

const EVENT_COPY: Record<string, string> = {
  "sale_campaign.created": "Created",
  "sale_campaign.edited": "Edited",
  "sale_campaign.scheduled": "Scheduled",
  "sale_campaign.unscheduled": "Back to draft",
  "sale_campaign.activated": "Activated",
  "sale_campaign.paused": "Paused",
  "sale_campaign.resumed": "Resumed",
  "sale_campaign.ending": "Ending: putting prices back",
  "sale_campaign.completed": "Completed",
  "sale_campaign.cancelled": "Cancelled",
  "sale_campaign.restore_requested": "Restore of original prices requested",
  "sale_campaign.retry_requested": "Retry of failed variants requested",
  "sale_campaign.conflict_detected": "Conflict with another campaign",
  "sale_campaign.apply_finished": "Finished applying",
  "sale_campaign.restore_finished": "Finished putting prices back",
  "sale_campaign.membership_changed": "Products joined or left",
};

function describeCampaignEvent(event: string, detail: unknown): string {
  const d = (detail ?? {}) as Record<string, unknown>;
  const base = EVENT_COPY[event] ?? event;
  const counts = d.counts as Record<string, number> | undefined;
  const parts: string[] = [];
  if (typeof d.by === "string" && d.by) parts.push(`by ${d.by}`);
  if (typeof d.variants === "number") parts.push(`${d.variants} variants`);
  if (counts) {
    const said = Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([state, n]) => `${n} ${state.replace("_", " ")}`);
    if (said.length > 0) parts.push(said.join(", "));
  }
  if (typeof d.added === "number" || typeof d.released === "number") {
    parts.push(`${d.added ?? 0} added, ${d.released ?? 0} released`);
  }
  if (Array.isArray(d.holders) && d.holders.length > 0)
    parts.push(`with ${d.holders.join(", ")}`);
  return parts.length > 0 ? `${base} — ${parts.join(" · ")}` : base;
}

export default function CampaignEditor() {
  const data = useLoaderData<typeof loader>();
  const {
    campaign,
    timeZone,
    facets,
    metafields,
    counts,
    run,
    preview,
    catalogue,
    events,
  } = data;
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data;
  const busy = fetcher.state !== "idle";
  const running = run?.status === "queued" || run?.status === "running";
  usePolling(running || catalogue.reading);

  const [form, setForm] = useState<CampaignForm>(data.form);
  const savedKey = JSON.stringify(data.form);
  const reset = useCallback(() => setForm(data.form), [data.form]);
  useResetWhenSaved(savedKey, reset);
  const dirty = JSON.stringify(form) !== savedKey;
  useSaveBar(SAVE_BAR_ID, dirty);

  const set = <K extends keyof CampaignForm>(key: K, value: CampaignForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const include = parseRuleGroup(JSON.parse(form.includeRules));
  const exclude = parseRuleGroup(JSON.parse(form.excludeRules));
  const setInclude = (group: RuleGroup) =>
    set("includeRules", JSON.stringify(group));
  const setExclude = (group: RuleGroup) =>
    set("excludeRules", JSON.stringify(group));

  const full = campaign.editability === "full";
  const limited = campaign.editability === "limited";
  const frozen = !full;

  useEffect(() => {
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [result]);

  const submit = (intent: string) =>
    fetcher.submit({ intent }, { method: "post" });
  const save = () =>
    fetcher.submit({ intent: "save", ...form }, { method: "post" });
  const errorFor = (field: string) =>
    result && !result.ok && result.field === field ? result.message : undefined;

  const failed = (counts.failed ?? 0) + (counts.restore_failed ?? 0);
  const onSale = (counts.applied ?? 0) + (counts.applying ?? 0);
  const review = counts.review ?? 0;
  const toModify = preview ? preview.applies + preview.conflicts.taken : 0;

  const scheduleReady =
    campaign.status === "draft" &&
    form.startMode === "at" &&
    !dirty &&
    campaign.startsAt !== null;

  return (
    <s-page heading={campaign.name} inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app/sales">
        Sales
      </s-link>

      {/* Lifecycle actions for this status. */}
      {campaign.status === "draft" || campaign.status === "scheduled" ? (
        <s-button
          slot="primary-action"
          variant="primary"
          command="--show"
          commandFor={CONFIRM_MODAL_ID}
          {...(busy || dirty || !preview || toModify === 0
            ? { disabled: true }
            : {})}
        >
          Activate now
        </s-button>
      ) : null}
      {campaign.status === "paused" ? (
        <s-button
          slot="primary-action"
          variant="primary"
          command="--show"
          commandFor={CONFIRM_MODAL_ID}
          {...(busy || dirty || !preview || toModify === 0
            ? { disabled: true }
            : {})}
        >
          Resume
        </s-button>
      ) : null}
      {campaign.status === "active" ? (
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          type="button"
          onClick={() => submit("end")}
          {...(busy ? { disabled: true } : {})}
        >
          End now
        </s-button>
      ) : null}

      {scheduleReady ? (
        <s-button
          slot="secondary-actions"
          type="button"
          onClick={() => submit("schedule")}
          {...(busy ? { disabled: true } : {})}
        >
          Schedule
        </s-button>
      ) : null}
      {campaign.status === "scheduled" ? (
        <s-button
          slot="secondary-actions"
          type="button"
          onClick={() => submit("unschedule")}
          {...(busy ? { disabled: true } : {})}
        >
          Back to draft
        </s-button>
      ) : null}
      {campaign.status === "active" ? (
        <s-button
          slot="secondary-actions"
          type="button"
          onClick={() => submit("pause")}
          {...(busy ? { disabled: true } : {})}
        >
          Pause
        </s-button>
      ) : null}
      {campaign.status === "paused" ? (
        <s-button
          slot="secondary-actions"
          type="button"
          onClick={() => submit("end")}
          {...(busy ? { disabled: true } : {})}
        >
          End
        </s-button>
      ) : null}
      {failed > 0 ? (
        <s-button
          slot="secondary-actions"
          type="button"
          onClick={() => submit("retry")}
          {...(busy ? { disabled: true } : {})}
        >
          {`Retry ${failed} failed`}
        </s-button>
      ) : null}
      {campaign.status === "draft" ||
      campaign.status === "scheduled" ||
      campaign.status === "paused" ? (
        <s-button
          slot="secondary-actions"
          type="button"
          tone="critical"
          onClick={() =>
            submit(
              campaign.status === "draft" &&
                onSale === 0 &&
                (counts.restored ?? 0) === 0
                ? "delete"
                : "cancel",
            )
          }
          {...(busy ? { disabled: true } : {})}
        >
          {campaign.status === "draft" ? "Delete" : "Cancel campaign"}
        </s-button>
      ) : null}
      {/* A finished campaign with every price back is history nobody needs on the list. */}
      {(campaign.status === "completed" || campaign.status === "cancelled") &&
      failed === 0 &&
      review === 0 &&
      onSale === 0 ? (
        <s-button
          slot="secondary-actions"
          type="button"
          tone="critical"
          onClick={() => submit("delete")}
          {...(busy ? { disabled: true } : {})}
        >
          Delete
        </s-button>
      ) : null}
      <s-button
        slot="secondary-actions"
        href={`/app/sales/${campaign.id}/variants`}
      >
        Variants
      </s-button>
      <s-button
        slot="secondary-actions"
        icon="question-circle"
        command="--show"
        commandFor={HELP_MODAL_ID}
      >
        Help
      </s-button>

      <s-modal
        id={CONFIRM_MODAL_ID}
        heading={
          campaign.status === "paused"
            ? "Resume the sale?"
            : "Activate the sale?"
        }
      >
        <s-stack direction="block" gap="base">
          <s-paragraph>
            {`You're about to modify ${toModify.toLocaleString("en")} Shopify variants${preview ? ` across ${preview.products.toLocaleString("en")} products` : ""}: ${campaign.discount}.`}
          </s-paragraph>
          <s-paragraph>
            Each variant&apos;s current price and compare-at price are recorded
            before it is written, and both are put back when the campaign ends.
          </s-paragraph>
          {preview && preview.conflicts.taken > 0 ? (
            <s-paragraph>
              {`${preview.conflicts.taken} of them are taken over from ${preview.conflicts.holders.join(", ")}; their prices are restored first.`}
            </s-paragraph>
          ) : null}
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          command="--hide"
          commandFor={CONFIRM_MODAL_ID}
          onClick={() => submit("activate")}
        >
          {campaign.status === "paused" ? "Resume" : "Activate"}
        </s-button>
        <s-button
          slot="secondary-actions"
          command="--hide"
          commandFor={CONFIRM_MODAL_ID}
        >
          Not now
        </s-button>
      </s-modal>

      <s-modal id={HELP_MODAL_ID} heading="About this campaign">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Targeting chooses the products; exclusions take some back out. The
            preview shows what activation would do and writes nothing.
          </s-paragraph>
          <s-paragraph>
            Once active, what is on sale is frozen: pause to change the rules or
            the discount, which puts prices back first. The name, notes and end
            date can change at any time.
          </s-paragraph>
          <s-paragraph>
            Times are in the shop&apos;s timezone ({timeZone}) and stored in
            UTC.
          </s-paragraph>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          command="--hide"
          commandFor={HELP_MODAL_ID}
        >
          Close
        </s-button>
      </s-modal>

      <s-stack direction="block" gap="large">
        {result && !result.ok && !result.field ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        {/* Where the campaign is. */}
        <s-section>
          <s-stack direction="block" gap="small-300">
            <s-stack direction="inline" gap="small-300" alignItems="center">
              <s-badge
                tone={campaign.status === "active" ? "success" : "neutral"}
              >
                {STATUS_LABEL[campaign.status]}
              </s-badge>
              {campaign.phase !== "idle" ? (
                <s-text color="subdued">{PHASE_LABEL[campaign.phase]}</s-text>
              ) : null}
            </s-stack>
            {running && run ? (
              <s-text>
                {`${run.kind === "restore" || run.kind === "release" ? "Putting prices back" : "Applying sale"}… ${run.done.toLocaleString("en")} / ${run.total.toLocaleString("en")} variants (${run.total > 0 ? Math.round((run.done / run.total) * 100) : 0}%)`}
              </s-text>
            ) : null}
            {campaign.status === "active" ||
            campaign.status === "paused" ||
            campaign.status === "completed" ? (
              <s-text color="subdued">
                {[
                  onSale > 0 ? `${onSale.toLocaleString("en")} on sale` : null,
                  (counts.skipped ?? 0) > 0
                    ? `${counts.skipped} skipped`
                    : null,
                  (counts.restored ?? 0) > 0
                    ? `${counts.restored} restored`
                    : null,
                  (counts.released ?? 0) > 0
                    ? `${counts.released} released`
                    : null,
                  failed > 0 ? `${failed} failed` : null,
                  review > 0 ? `${review} need a decision` : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "No variants yet."}
              </s-text>
            ) : null}
            {campaign.status === "active" ? (
              <s-text color="subdued">
                {campaign.endsAt
                  ? `Ends ${formatInZone(campaign.endsAt, timeZone)}.`
                  : "No end date. End it from here when the sale is over."}
              </s-text>
            ) : null}
            {campaign.status === "scheduled" && campaign.startsAt ? (
              <s-text color="subdued">{`Starts ${formatInZone(campaign.startsAt, timeZone)}.`}</s-text>
            ) : null}
            {failed > 0 || review > 0 ? (
              <s-banner
                tone="critical"
                heading={
                  failed > 0
                    ? `${failed} variants failed`
                    : `${review} variants need a decision`
                }
              >
                <s-paragraph>
                  {failed > 0
                    ? "Shopify rejected the write for these. The variants page shows its reason for each; fix it and retry."
                    : "Their price was changed outside the campaign. Decide for each on the variants page."}
                </s-paragraph>
                <s-link href={`/app/sales/${campaign.id}/variants`}>
                  Open variants
                </s-link>
              </s-banner>
            ) : null}
          </s-stack>
        </s-section>

        {/* General */}
        <s-section heading="General">
          <s-stack direction="block" gap="base">
            <s-text-field
              label="Name"
              value={form.name}
              onChange={(event) => set("name", event.currentTarget.value)}
              {...(errorFor("name") ? { error: errorFor("name") } : {})}
              {...(campaign.editability === "none" ? { disabled: true } : {})}
            />
            <s-text-area
              label="Internal notes"
              details="For your team. Customers never see this."
              value={form.notes}
              onChange={(event) => set("notes", event.currentTarget.value)}
              {...(campaign.editability === "none" ? { disabled: true } : {})}
            />
            <s-text color="subdued">
              {`Created ${formatDateTime(campaign.createdAt)}${campaign.createdBy ? ` by ${campaign.createdBy}` : ""}.`}
            </s-text>
          </s-stack>
        </s-section>

        {frozen && campaign.status === "active" ? (
          <s-banner tone="info">
            <s-paragraph>
              This campaign is live, so its products, discount and policies are
              frozen. Pause it to change them; pausing puts prices back first.
            </s-paragraph>
          </s-banner>
        ) : null}

        {/* Targeting */}
        <s-section heading="Targeting">
          <s-stack direction="block" gap="base">
            <s-paragraph>Include products where…</s-paragraph>
            <RuleBuilder
              purpose="include"
              value={include}
              onChange={setInclude}
              facets={facets}
              metafields={metafields}
              currency={campaign.currency}
              {...(frozen ? { disabled: true } : {})}
            />
            {errorFor("includeRules") ? (
              <s-text tone="critical">{errorFor("includeRules")}</s-text>
            ) : null}
            {preview ? (
              <s-text color="subdued">
                {dirty
                  ? "Save to update the count."
                  : `Matches ${preview.includedVariants.toLocaleString("en")} variants before exclusions.`}
              </s-text>
            ) : null}
          </s-stack>
        </s-section>

        {/* Exclusions */}
        <s-section heading="Exclusions">
          <s-stack direction="block" gap="base">
            <s-paragraph>…but not products where…</s-paragraph>
            <RuleBuilder
              purpose="exclude"
              value={exclude}
              onChange={setExclude}
              facets={facets}
              metafields={metafields}
              currency={campaign.currency}
              {...(frozen ? { disabled: true } : {})}
            />
            {errorFor("excludeRules") ? (
              <s-text tone="critical">{errorFor("excludeRules")}</s-text>
            ) : null}
            {preview && !dirty ? (
              <s-stack direction="block" gap="small-500">
                <s-text color="subdued">{`Applies to: ${preview.includedVariants.toLocaleString("en")} variants`}</s-text>
                <s-text color="subdued">{`Excluded: ${preview.excludedVariants.toLocaleString("en")} variants`}</s-text>
                <s-text type="strong">{`Final: ${preview.variants.toLocaleString("en")} variants in ${preview.products.toLocaleString("en")} products`}</s-text>
              </s-stack>
            ) : null}
          </s-stack>
        </s-section>

        {/* Discount */}
        <s-section heading="Discount">
          <s-stack direction="block" gap="base">
            <s-choice-list
              label="Type"
              name="discountType"
              values={[form.discountType]}
              onChange={(event) => {
                const next = event.currentTarget.values[0];
                if (
                  next === "percentage" ||
                  next === "fixed_amount" ||
                  next === "fixed_price"
                ) {
                  set("discountType", next);
                }
              }}
              {...(frozen ? { disabled: true } : {})}
            >
              {(
                Object.keys(DISCOUNT_TYPE_LABEL) as Array<
                  keyof typeof DISCOUNT_TYPE_LABEL
                >
              ).map((type) => (
                <s-choice key={type} value={type}>
                  {DISCOUNT_TYPE_LABEL[type]}
                </s-choice>
              ))}
            </s-choice-list>
            <s-grid
              gridTemplateColumns="@container (inline-size <= 560px) 1fr, 1fr 1fr"
              gap="base"
            >
              <s-text-field
                label={
                  form.discountType === "percentage"
                    ? "Percent off"
                    : form.discountType === "fixed_amount"
                      ? `Amount off (${campaign.currency})`
                      : `Sale price (${campaign.currency})`
                }
                value={form.discountValue}
                onChange={(event) =>
                  set("discountValue", event.currentTarget.value)
                }
                {...(errorFor("discountValue")
                  ? { error: errorFor("discountValue") }
                  : {})}
                {...(frozen ? { disabled: true } : {})}
              />
              <Dropdown
                name="rounding"
                label="Rounding"
                value={form.rounding}
                options={(
                  Object.keys(ROUNDING_LABEL) as Array<
                    keyof typeof ROUNDING_LABEL
                  >
                ).map((mode) => ({
                  value: mode,
                  label: ROUNDING_LABEL[mode],
                }))}
                onChange={(mode) =>
                  set("rounding", mode as CampaignForm["rounding"])
                }
                {...(frozen ? { disabled: true } : {})}
              />
            </s-grid>
            {form.rounding === "increment" ? (
              <s-text-field
                label={`Increment (${campaign.currency})`}
                details="For example 5.00 rounds 1,823.27 to 1,825.00."
                value={form.roundingIncrement}
                onChange={(event) =>
                  set("roundingIncrement", event.currentTarget.value)
                }
                {...(errorFor("roundingIncrement")
                  ? { error: errorFor("roundingIncrement") }
                  : {})}
                {...(frozen ? { disabled: true } : {})}
              />
            ) : null}
            <s-text color="subdued">
              1,823.27 becomes 1,823 (nearest whole number), 1,822.99 (end in
              .99), 1,819 (end in 9) or 1,799.99 (end in 99.99). Endings round
              down, so the sale is never smaller than advertised.
            </s-text>
          </s-stack>
        </s-section>

        {/* Schedule */}
        <s-section heading="Schedule">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">{`Times are in ${timeZone}.`}</s-text>
            {campaign.status !== "active" ? (
              <s-choice-list
                label="Start"
                name="startMode"
                values={[form.startMode]}
                onChange={(event) => {
                  const next = event.currentTarget.values[0];
                  if (next === "now" || next === "at") set("startMode", next);
                }}
                {...(frozen ? { disabled: true } : {})}
              >
                <s-choice value="now">When activated</s-choice>
                <s-choice value="at">At a date and time</s-choice>
              </s-choice-list>
            ) : (
              <s-text>{`Started ${campaign.startsAt ? formatInZone(campaign.startsAt, timeZone) : ""}.`}</s-text>
            )}
            {form.startMode === "at" && campaign.status !== "active" ? (
              <s-grid
                gridTemplateColumns="@container (inline-size <= 560px) 1fr, 2fr 1fr"
                gap="base"
              >
                <s-date-field
                  label="Start date"
                  value={form.startDate}
                  onChange={(event) =>
                    set("startDate", event.currentTarget.value)
                  }
                  {...(errorFor("startDate")
                    ? { error: errorFor("startDate") }
                    : {})}
                  {...(frozen ? { disabled: true } : {})}
                />
                <s-text-field
                  label="Start time"
                  placeholder="00:00"
                  value={form.startTime}
                  onChange={(event) =>
                    set("startTime", event.currentTarget.value)
                  }
                  {...(frozen ? { disabled: true } : {})}
                />
              </s-grid>
            ) : null}
            <s-choice-list
              label="End"
              name="endMode"
              values={[form.endMode]}
              onChange={(event) => {
                const next = event.currentTarget.values[0];
                if (next === "none" || next === "at") set("endMode", next);
              }}
              {...(campaign.editability === "none" ? { disabled: true } : {})}
            >
              <s-choice value="none">No end date</s-choice>
              <s-choice value="at">At a date and time</s-choice>
            </s-choice-list>
            {form.endMode === "at" ? (
              <s-grid
                gridTemplateColumns="@container (inline-size <= 560px) 1fr, 2fr 1fr"
                gap="base"
              >
                <s-date-field
                  label="End date"
                  value={form.endDate}
                  onChange={(event) =>
                    set("endDate", event.currentTarget.value)
                  }
                  {...(errorFor("endDate")
                    ? { error: errorFor("endDate") }
                    : {})}
                  {...(campaign.editability === "none"
                    ? { disabled: true }
                    : {})}
                />
                <s-text-field
                  label="End time"
                  placeholder="23:59"
                  value={form.endTime}
                  onChange={(event) =>
                    set("endTime", event.currentTarget.value)
                  }
                  {...(campaign.editability === "none"
                    ? { disabled: true }
                    : {})}
                />
              </s-grid>
            ) : null}
            {campaign.status === "draft" && form.startMode === "at" ? (
              <s-text color="subdued">
                Save, then press Schedule to have it start on its own.
              </s-text>
            ) : null}
          </s-stack>
        </s-section>

        {/* Conflict handling */}
        <s-section heading="Conflict handling">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              When a variant is in another campaign at the same time. Prices are
              never stacked: one campaign holds a variant, or none does.
            </s-text>
            <s-choice-list
              label="If another campaign holds a variant"
              name="conflictStrategy"
              values={[form.conflictStrategy]}
              onChange={(event) => {
                const next = event.currentTarget.values[0] ?? "";
                if (next in CONFLICT_LABEL)
                  set(
                    "conflictStrategy",
                    next as CampaignForm["conflictStrategy"],
                  );
              }}
              {...(frozen ? { disabled: true } : {})}
            >
              {(
                Object.keys(CONFLICT_LABEL) as Array<
                  keyof typeof CONFLICT_LABEL
                >
              ).map((strategy) => (
                <s-choice key={strategy} value={strategy}>
                  {CONFLICT_LABEL[strategy].label}
                  <s-text slot="details">
                    {CONFLICT_LABEL[strategy].detail}
                  </s-text>
                </s-choice>
              ))}
            </s-choice-list>
            <s-box inlineSize="200px">
              <s-text-field
                label="Priority"
                details="Higher wins under “Higher priority wins”."
                value={form.priority}
                onChange={(event) => set("priority", event.currentTarget.value)}
                {...(errorFor("priority")
                  ? { error: errorFor("priority") }
                  : {})}
                {...(frozen ? { disabled: true } : {})}
              />
            </s-box>
          </s-stack>
        </s-section>

        {/* Advanced */}
        <AdvancedSection
          summary={`${EXISTING_SALE_LABEL[form.existingSalePolicy].label} · ${BASE_CHANGE_LABEL[form.basePriceChangePolicy].label} · ${form.dynamicMembership === "on" ? "products join and leave on their own" : "products fixed at activation"}`}
        >
          <s-stack direction="block" gap="large">
            <s-choice-list
              label="Products already on sale"
              name="existingSalePolicy"
              values={[form.existingSalePolicy]}
              onChange={(event) => {
                const next = event.currentTarget.values[0] ?? "";
                if (next in EXISTING_SALE_LABEL)
                  set(
                    "existingSalePolicy",
                    next as CampaignForm["existingSalePolicy"],
                  );
              }}
              {...(frozen ? { disabled: true } : {})}
            >
              {(
                Object.keys(EXISTING_SALE_LABEL) as Array<
                  keyof typeof EXISTING_SALE_LABEL
                >
              ).map((policy) => (
                <s-choice key={policy} value={policy}>
                  {EXISTING_SALE_LABEL[policy].label}
                  <s-text slot="details">
                    {EXISTING_SALE_LABEL[policy].detail}
                  </s-text>
                </s-choice>
              ))}
            </s-choice-list>
            <s-text color="subdued">
              A variant is “already on sale” when its compare-at price is above
              its price. The original pair is recorded whatever you choose, so
              it is put back exactly.
            </s-text>

            <s-choice-list
              label="If a price changes outside the campaign while it is live"
              name="basePriceChangePolicy"
              values={[form.basePriceChangePolicy]}
              onChange={(event) => {
                const next = event.currentTarget.values[0] ?? "";
                if (next in BASE_CHANGE_LABEL)
                  set(
                    "basePriceChangePolicy",
                    next as CampaignForm["basePriceChangePolicy"],
                  );
              }}
              {...(frozen ? { disabled: true } : {})}
            >
              {(
                Object.keys(BASE_CHANGE_LABEL) as Array<
                  keyof typeof BASE_CHANGE_LABEL
                >
              ).map((policy) => (
                <s-choice key={policy} value={policy}>
                  {BASE_CHANGE_LABEL[policy].label}
                  <s-text slot="details">
                    {BASE_CHANGE_LABEL[policy].detail}
                  </s-text>
                </s-choice>
              ))}
            </s-choice-list>
            <s-text color="subdued">
              An ERP price sync or a person in the admin can change a price this
              campaign is holding. The campaign notices from Shopify&apos;s own
              webhook and never mistakes its own write for somebody else&apos;s.
            </s-text>

            <s-checkbox
              label="Keep membership up to date"
              details="Products that start matching the rules join the sale; products that stop matching have their price put back. Off: only the products matched at activation are affected."
              checked={form.dynamicMembership === "on"}
              onChange={(event) =>
                set(
                  "dynamicMembership",
                  event.currentTarget.checked ? "on" : "off",
                )
              }
              {...(frozen ? { disabled: true } : {})}
            />
          </s-stack>
        </AdvancedSection>

        {/* Preview */}
        <s-section heading="Preview">
          <s-stack direction="block" gap="base">
            {catalogue.snapshotAt === null ? (
              <s-banner
                tone="warning"
                heading="The catalogue has not been read yet"
              >
                <s-stack direction="block" gap="small-300">
                  <s-paragraph>
                    {catalogue.reading
                      ? "Reading it from Shopify now. The preview appears when it finishes."
                      : "Read the catalogue once to see what this campaign would do."}
                  </s-paragraph>
                  {!catalogue.reading ? (
                    <s-stack direction="inline">
                      <s-button
                        type="button"
                        onClick={() => submit("refresh-catalogue")}
                      >
                        Read the catalogue
                      </s-button>
                    </s-stack>
                  ) : null}
                </s-stack>
              </s-banner>
            ) : null}

            {preview ? (
              <>
                {dirty ? (
                  <s-banner tone="info">
                    <s-paragraph>
                      Save to preview the changes you are making.
                    </s-paragraph>
                  </s-banner>
                ) : null}
                <s-stack direction="block" gap="small-500">
                  <s-heading>{campaign.discount}</s-heading>
                  <s-text>{`Products: ${preview.products.toLocaleString("en")}`}</s-text>
                  <s-text>{`Variants: ${preview.variants.toLocaleString("en")}`}</s-text>
                  <s-text type="strong">{`Will be changed: ${preview.applies.toLocaleString("en")}`}</s-text>
                </s-stack>

                {preview.examples.length > 0 ? (
                  <s-table variant="auto">
                    <s-table-header-row>
                      <s-table-header listSlot="primary">
                        Product
                      </s-table-header>
                      <s-table-header listSlot="kicker">SKU</s-table-header>
                      <s-table-header listSlot="secondary">
                        Price
                      </s-table-header>
                    </s-table-header-row>
                    <s-table-body>
                      {preview.examples.map((example) => (
                        <s-table-row key={example.variantId}>
                          <s-table-cell>
                            <s-link
                              href={`/app/products/${example.productId.replace(/^gid:\/\/shopify\/Product\//, "")}`}
                            >
                              {example.title}
                            </s-link>
                          </s-table-cell>
                          <s-table-cell>
                            <s-text color="subdued">
                              {example.sku ?? "—"}
                            </s-text>
                          </s-table-cell>
                          <s-table-cell>
                            {`${formatMoney(example.beforeMinor, example.currency)} → ${formatMoney(example.afterMinor, example.currency)}`}
                          </s-table-cell>
                        </s-table-row>
                      ))}
                    </s-table-body>
                  </s-table>
                ) : null}

                <s-stack direction="block" gap="small-500">
                  <s-text color="subdued">{`Excluded: ${preview.excludedVariants.toLocaleString("en")}`}</s-text>
                  {Object.entries(preview.skipped).map(([reason, n]) => (
                    <s-text key={reason} color="subdued">
                      {`${SKIP_REASON_LABEL[reason] ?? reason}: ${n.toLocaleString("en")}`}
                    </s-text>
                  ))}
                  {preview.conflicts.refused +
                    preview.conflicts.taken +
                    preview.conflicts.lost >
                  0 ? (
                    <s-text tone="critical">
                      {`Conflicts: ${(preview.conflicts.refused + preview.conflicts.taken + preview.conflicts.lost).toLocaleString("en")} variants are held by ${preview.conflicts.holders.join(", ")}` +
                        (preview.conflicts.refused > 0
                          ? " — activation is refused under “Do not overlap”."
                          : ` — ${preview.conflicts.taken} would be taken over, ${preview.conflicts.lost} left with the other campaign.`)}
                    </s-text>
                  ) : null}
                  {preview.scheduledOverlaps.map((overlap) => (
                    <s-text key={overlap.campaignId} tone="caution">
                      {`Overlaps “${overlap.name}” (${STATUS_LABEL[overlap.status].toLowerCase()}) on ${overlap.variants.toLocaleString("en")} variants during the same period.`}
                    </s-text>
                  ))}
                </s-stack>

                {preview.fixedPriceMarkets.length > 0 ? (
                  <s-banner tone="info" heading="Markets with fixed prices">
                    <s-paragraph>
                      {`${preview.fixedPriceMarkets.map((m) => `${m.name} (${m.currency}, ${m.fixedPrices} fixed prices)`).join("; ")}. Fixed market prices do not follow the base price, so those variants keep their market price during the sale. Markets priced by percentage or by currency conversion follow it.`}
                    </s-paragraph>
                  </s-banner>
                ) : null}

                {preview.discounts ? (
                  preview.discounts.kind === "unavailable" ? (
                    <s-text color="subdued">{`Shopify automatic discounts: not checked. ${preview.discounts.reason}`}</s-text>
                  ) : preview.discounts.discounts.length > 0 ? (
                    <s-banner
                      tone="warning"
                      heading="Shopify automatic discounts are active"
                    >
                      <s-paragraph>
                        {`${preview.discounts.discounts.map((d) => `${d.title} (${d.kind})`).join(", ")}. If any of them applies to these products, checkout will discount the sale price again. This campaign does not create a Shopify discount.`}
                      </s-paragraph>
                    </s-banner>
                  ) : (
                    <s-text color="subdued">
                      No Shopify automatic discounts are active.
                    </s-text>
                  )
                ) : null}

                <s-stack direction="inline" gap="small-300">
                  <s-button href={`/app/sales/${campaign.id}/variants`}>
                    See every variant
                  </s-button>
                  <s-button
                    href={`/app/sales/${campaign.id}/variants.csv`}
                    target="_blank"
                  >
                    Export CSV
                  </s-button>
                </s-stack>
                <s-text color="subdued">
                  {`From the catalogue read ${formatDateTime(preview.snapshotAt ?? catalogue.snapshotAt ?? "")}. Nothing is changed by previewing.`}
                </s-text>
              </>
            ) : campaign.status === "active" ||
              campaign.status === "completed" ||
              campaign.status === "cancelled" ? (
              <s-stack direction="inline" gap="small-300">
                <s-button href={`/app/sales/${campaign.id}/variants`}>
                  See every variant
                </s-button>
                <s-button
                  href={`/app/sales/${campaign.id}/variants.csv`}
                  target="_blank"
                >
                  Export CSV
                </s-button>
              </s-stack>
            ) : null}
          </s-stack>
        </s-section>

        {/* Activity */}
        <s-section heading="Activity">
          {events.length === 0 ? (
            <s-text color="subdued">Nothing yet.</s-text>
          ) : (
            <s-stack direction="block" gap="small-300">
              {events.map((event) => (
                <s-grid
                  key={event.id}
                  gridTemplateColumns="auto 1fr"
                  gap="base"
                >
                  <s-text color="subdued">{formatDateTime(event.at)}</s-text>
                  <s-text>
                    {describeCampaignEvent(event.event, event.detail)}
                  </s-text>
                </s-grid>
              ))}
            </s-stack>
          )}
        </s-section>
      </s-stack>

      {/* The save bar. `data-save-bar` cannot see React-driven fields; the page drives it. */}
      <ui-save-bar id={SAVE_BAR_ID}>
        <button
          variant="primary"
          onClick={save}
          {...(busy || (!full && !limited) ? { disabled: true } : {})}
        >
          Save
        </button>
        <button onClick={reset}>Discard</button>
      </ui-save-bar>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
