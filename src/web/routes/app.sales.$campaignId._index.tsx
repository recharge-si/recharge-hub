import { boundary } from "@shopify/shopify-app-react-router/server";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { resolveAllReviewRows } from "~/adapters/sales/review.server";
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
import { CampaignActivity } from "~/web/components/campaign-activity";
import { CampaignAdvanced } from "~/web/components/campaign-advanced";
import { CampaignConflicts } from "~/web/components/campaign-conflicts";
import { CampaignDetails } from "~/web/components/campaign-details";
import { CampaignDiscount } from "~/web/components/campaign-discount";
import { CampaignHeaderActions } from "~/web/components/campaign-header";
import { ConfirmModal } from "~/web/components/confirm-modal";
import { CampaignSchedule } from "~/web/components/campaign-schedule";
import {
  CampaignStatus,
  CampaignSummary,
} from "~/web/components/campaign-summary";
import { CampaignTargeting } from "~/web/components/campaign-targeting";
import { CampaignWarnings } from "~/web/components/campaign-warnings";
import {
  conflictSummary,
  describeFormDiscount,
  scheduleSummary,
} from "~/web/lib/campaign-editor";
import {
  actorFromSession,
  principalFromSession,
} from "~/web/lib/principal.server";
import { redirectWithin } from "~/web/lib/redirects";
import {
  describeDiscount,
  formatAmountInput,
  formatBasisPoints,
  utcToZoned,
} from "~/web/lib/sales";
import {
  buildPreview,
  campaignFormSchema,
  campaignWithInput,
  parseCampaignForm,
  type CampaignForm,
  type Preview,
} from "~/web/lib/sales.server";
import { useResetWhenSaved, useSaveBar } from "~/web/lib/use-save-bar";

/**
 * The campaign editor (docs/sale-campaigns.md § UI).
 *
 * Two columns. The main one is the campaign in the order it is built —
 * details, products, discount, schedule, conflict handling, advanced — with
 * its trail folded at the foot; the sidebar is where the campaign stands
 * and what it comes to, and stays in view while the main column scrolls.
 * The header carries the lifecycle actions the current status allows.
 * Everything the merchant edits is saved as a draft of settings; nothing in
 * Shopify changes until Activate, and Activate goes through a confirmation
 * naming the count.
 *
 * The preview is computed from the catalogue snapshot and writes nothing
 * (docs/ui-conventions.md § Destructive writes): once on load for the saved
 * campaign, and again, debounced, for the unsaved form whenever a field the
 * preview reads has changed — so the sidebar's numbers follow the edit.
 */
const SAVE_BAR_ID = "sale-campaign-save-bar";
const CONFIRM_MODAL_ID = "confirm-activate";
const CONFIRM_IDS = {
  end: "confirm-end",
  pause: "confirm-pause",
  cancel: "confirm-cancel",
  delete: "confirm-delete",
  reviewRestore: "confirm-review-restore",
  reviewRelease: "confirm-review-release",
} as const;
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

type ActionResult = {
  ok: boolean;
  message: string;
  field?: string;
  /** Only from the `preview` intent. */
  preview?: Preview;
};

export const action = async ({
  request,
  params,
}: ActionFunctionArgs): Promise<ActionResult> => {
  const { session, admin } = await authenticate.admin(request);
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

  /*
   * The preview for the unsaved form. Read-only, exactly like the one on
   * load, and skipped for the Shopify discount read the sidebar already
   * has from that one.
   */
  if (intent === "preview") {
    const raw: Record<string, string> = {};
    for (const [key, value] of formData.entries()) {
      if (typeof value === "string") raw[key] = value;
    }
    const parsedForm = campaignFormSchema.safeParse(raw);
    if (!parsedForm.success)
      return { ok: false, message: "The form could not be read." };
    const catalogue = await getCatalogueState(principal);
    if (!catalogue.snapshotAt)
      return { ok: false, message: "The catalogue has not been read yet." };
    const outcome = parseCampaignForm(parsedForm.data, {
      timeZone: catalogue.ianaTimezone ?? "UTC",
      currency: campaign.currency,
      now,
    });
    if (!outcome.ok)
      return { ok: false, field: outcome.field, message: outcome.message };
    const preview = await buildPreview(
      principal,
      campaignWithInput(campaign, outcome.input),
      null,
    );
    return { ok: true, message: "", preview };
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
    case "review-restore-all":
      return resolveAllReviewRows(
        admin,
        principal,
        campaign.id,
        "restore",
        options,
      );
    case "review-release-all":
      return resolveAllReviewRows(
        admin,
        principal,
        campaign.id,
        "release",
        options,
      );
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

/** The fields whose change alters what the preview would count. */
const PREVIEW_FIELDS = [
  "includeRules",
  "excludeRules",
  "discountType",
  "discountValue",
  "rounding",
  "roundingIncrement",
  "existingSalePolicy",
  "conflictStrategy",
  "priority",
  "startMode",
  "startDate",
  "startTime",
  "endMode",
  "endDate",
  "endTime",
] as const satisfies ReadonlyArray<keyof CampaignForm>;

function previewKeyOf(form: CampaignForm): string {
  return JSON.stringify(PREVIEW_FIELDS.map((field) => form[field]));
}

/**
 * The preview for the form as it is being edited: asked for, debounced,
 * whenever a field the preview reads has changed from what is saved, and
 * dropped again the moment the form matches the saved campaign. Nothing is
 * written by it (docs/ui-conventions.md § Destructive writes).
 *
 * The answer is tied to the form it was asked for. While a newer form waits
 * for its answer the previous one stays on screen under a spinner, so the
 * numbers never jump back to the saved campaign's between keystrokes.
 */
function useLivePreview(
  form: CampaignForm,
  savedForm: CampaignForm,
  enabled: boolean,
): {
  preview: Preview | null;
  refreshing: boolean;
  note: string | null;
} {
  const fetcher = useFetcher<typeof action>();
  const latest = useRef(form);
  latest.current = form;
  const key = previewKeyOf(form);
  const savedKey = previewKeyOf(savedForm);
  const wanted = enabled && key !== savedKey;
  const askedFor = useRef<string | null>(null);
  const [answer, setAnswer] = useState<{
    key: string;
    preview: Preview | null;
    note: string | null;
  } | null>(null);

  useEffect(() => {
    if (!wanted) return;
    const timer = setTimeout(() => {
      askedFor.current = key;
      fetcher.submit(
        { intent: "preview", ...latest.current },
        { method: "post" },
      );
    }, 500);
    return () => clearTimeout(timer);
    // Keyed on the form's content, not the fetcher: its identity changes with
    // every state change, and re-arming the timer on those would never fire.
  }, [wanted, key]);

  const data = fetcher.data;
  useEffect(() => {
    if (fetcher.state !== "idle" || !data || askedFor.current === null) return;
    setAnswer({
      key: askedFor.current,
      preview: data.ok && data.preview ? data.preview : null,
      note: data.ok
        ? null
        : `Counts are for the saved campaign. ${data.message}`,
    });
  }, [fetcher.state, data]);

  if (!wanted) return { preview: null, refreshing: false, note: null };
  const current = answer?.key === key ? answer : null;
  return {
    preview: current?.preview ?? answer?.preview ?? null,
    refreshing: current === null,
    note: current?.note ?? null,
  };
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
  const readOnly = campaign.editability === "none";

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

  const deletable =
    campaign.status === "draft"
      ? onSale === 0 && (counts.restored ?? 0) === 0
      : failed === 0 && review === 0 && onSale === 0;

  /* The numbers the sidebar shows follow the unsaved form. */
  const live = useLivePreview(
    form,
    data.form,
    full && catalogue.snapshotAt !== null,
  );
  const shown = live.preview ?? preview;
  const summaryCounts = shown
    ? {
        products: shown.products,
        variants: shown.variants,
        includedVariants: shown.includedVariants,
        excludedVariants: shown.excludedVariants,
        willChange: shown.applies + shown.conflicts.taken,
        skipped: shown.skipped,
      }
    : null;
  const exampleVariant = shown?.examples[0]
    ? { title: shown.examples[0].title, baseMinor: shown.examples[0].baseMinor }
    : null;
  const schedule = scheduleSummary(form, timeZone, {
    status: campaign.status,
    startedAt: campaign.startsAt,
  });

  const variantsHref = `/app/sales/${campaign.id}/variants`;
  const csvHref = `/app/sales/${campaign.id}/variants.csv`;
  const activatable =
    campaign.status === "draft" ||
    campaign.status === "scheduled" ||
    campaign.status === "paused";

  /* Why the way forward is closed, in one line beside the button. */
  const actionNote = !activatable ? null : catalogue.snapshotAt === null ? (
    "Read the catalogue to see what this campaign would change."
  ) : dirty ? (
    "Save your changes first. Activation uses what is saved."
  ) : toModify === 0 ? (
    <>
      Nothing would change yet: no variant the discount lowers.{" "}
      <s-link href="#campaign-products">Choose products</s-link>.
    </>
  ) : null;

  return (
    <s-page heading={campaign.name} inlineSize="base">
      <s-link slot="breadcrumb-actions" href="/app/sales">
        Sales
      </s-link>

      <CampaignHeaderActions
        status={campaign.status}
        busy={busy}
        dirty={dirty}
        canActivate={preview !== null && toModify > 0}
        scheduleReady={scheduleReady}
        failed={failed}
        deletable={deletable}
        variantsHref={variantsHref}
        confirmModalId={CONFIRM_MODAL_ID}
        helpModalId={HELP_MODAL_ID}
        confirmIds={CONFIRM_IDS}
        onIntent={submit}
      />

      {/* Hard-to-undo actions ask first. Each names what it does to prices. */}
      <ConfirmModal
        id={CONFIRM_IDS.end}
        heading="End the campaign?"
        confirmLabel="End campaign"
        onConfirm={() => submit("end")}
      >
        <s-paragraph>
          {`The sale stops now. ${onSale.toLocaleString("en")} variants go back to their original price and compare-at price, and the campaign is completed.`}
        </s-paragraph>
        <s-paragraph>A completed campaign cannot be resumed.</s-paragraph>
      </ConfirmModal>
      <ConfirmModal
        id={CONFIRM_IDS.pause}
        heading="Pause the campaign?"
        confirmLabel="Pause"
        tone="neutral"
        onConfirm={() => submit("pause")}
      >
        <s-paragraph>
          {`${onSale.toLocaleString("en")} variants go back to their original price. The campaign keeps its products and can be resumed, which takes a fresh snapshot and applies the sale again.`}
        </s-paragraph>
      </ConfirmModal>
      <ConfirmModal
        id={CONFIRM_IDS.cancel}
        heading="Cancel the campaign?"
        confirmLabel="Cancel campaign"
        onConfirm={() => submit("cancel")}
      >
        <s-paragraph>
          It will not run. Its settings and history are kept, but a cancelled
          campaign cannot be activated again.
        </s-paragraph>
      </ConfirmModal>
      <ConfirmModal
        id={CONFIRM_IDS.delete}
        heading="Delete the campaign?"
        confirmLabel="Delete"
        onConfirm={() => submit("delete")}
      >
        <s-paragraph>
          The campaign, its rules and its price snapshot are removed. No price
          in Shopify changes. This cannot be undone; the activity trail stays.
        </s-paragraph>
      </ConfirmModal>

      <ConfirmModal
        id={CONFIRM_IDS.reviewRestore}
        heading="Put every original price back?"
        confirmLabel="Put them back"
        tone="neutral"
        onConfirm={() => submit("review-restore-all")}
      >
        <s-paragraph>
          {`${review.toLocaleString("en")} variants get the price and compare-at price recorded before the sale, whatever they show now. The change somebody made outside the campaign is overwritten.`}
        </s-paragraph>
      </ConfirmModal>
      <ConfirmModal
        id={CONFIRM_IDS.reviewRelease}
        heading="Leave every variant as it is?"
        confirmLabel="Leave them"
        tone="neutral"
        onConfirm={() => submit("review-release-all")}
      >
        <s-paragraph>
          {`${review.toLocaleString("en")} variants keep the price they show now and are released from the campaign. Nothing in Shopify changes.`}
        </s-paragraph>
      </ConfirmModal>

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
            {`This changes the price of ${toModify.toLocaleString("en")} Shopify variants${preview ? ` across ${preview.products.toLocaleString("en")} products` : ""}: ${campaign.discount}.`}
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
            Products chooses what goes on sale; exclusions take some back out.
            The summary shows what activation would do and writes nothing.
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

      {/* Main column: the campaign, top to bottom in the order it is built. */}
      <s-stack direction="block" gap="base">
        {result && !result.ok && !result.field ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}
        {result && !result.ok && result.field ? (
          <s-banner tone="critical" heading="Not saved">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        <CampaignDetails
          name={form.name}
          notes={form.notes}
          onNameChange={(name) => set("name", name)}
          onNotesChange={(notes) => set("notes", notes)}
          nameError={errorFor("name")}
          disabled={readOnly}
        />

        <CampaignTargeting
          id="campaign-products"
          include={include}
          exclude={exclude}
          onIncludeChange={setInclude}
          onExcludeChange={setExclude}
          facets={facets}
          metafields={metafields}
          currency={campaign.currency}
          disabled={frozen}
          includeError={errorFor("includeRules")}
          excludeError={errorFor("excludeRules")}
          counts={summaryCounts}
          refreshing={live.refreshing}
          countsNote={live.note}
        />

        <CampaignDiscount
          form={form}
          currency={campaign.currency}
          onChange={set}
          errorFor={errorFor}
          disabled={frozen}
          exampleVariant={exampleVariant}
        />

        <CampaignSchedule
          form={form}
          onChange={set}
          errorFor={errorFor}
          timeZone={timeZone}
          status={campaign.status}
          startedAt={campaign.startsAt}
          startDisabled={frozen}
          disabled={readOnly}
        />

        <CampaignConflicts
          strategy={form.conflictStrategy}
          priority={form.priority}
          onStrategyChange={(strategy) => set("conflictStrategy", strategy)}
          onPriorityChange={(priority) => set("priority", priority)}
          priorityError={errorFor("priority")}
          disabled={frozen}
        />

        <CampaignAdvanced
          existingSalePolicy={form.existingSalePolicy}
          basePriceChangePolicy={form.basePriceChangePolicy}
          dynamicMembership={form.dynamicMembership}
          onChange={set}
          disabled={frozen}
        />

        <CampaignActivity events={events} />
      </s-stack>

      {/*
       * Sidebar: status, the summary, warnings. Sticky, so the answer stays
       * beside the question while the form scrolls; capped at the viewport
       * and scrolling inside it, so nothing in it is ever out of reach on a
       * short screen. Layout only — every colour and space is Polaris's.
       */}
      <div
        slot="aside"
        style={{
          position: "sticky",
          top: "1rem",
          maxHeight: "calc(100vh - 2rem)",
          overflowY: "auto",
        }}
      >
        <s-stack direction="block" gap="base">
          <CampaignStatus
            status={campaign.status}
            phase={campaign.phase}
            run={run}
            counts={counts}
            startsAt={campaign.startsAt}
            endsAt={campaign.endsAt}
            timeZone={timeZone}
            createdAt={campaign.createdAt}
            createdBy={campaign.createdBy}
            variantsHref={variantsHref}
            action={
              activatable ? (
                <s-stack direction="block" gap="small-300">
                  {campaign.status === "draft" && scheduleReady ? (
                    <s-button
                      variant="primary"
                      type="button"
                      inlineSize="fill"
                      onClick={() => submit("schedule")}
                      {...(busy ? { disabled: true } : {})}
                    >
                      Schedule campaign
                    </s-button>
                  ) : null}
                  <s-button
                    variant={
                      campaign.status === "draft" && scheduleReady
                        ? "secondary"
                        : "primary"
                    }
                    inlineSize="fill"
                    command="--show"
                    commandFor={CONFIRM_MODAL_ID}
                    {...(busy || dirty || !preview || toModify === 0
                      ? { disabled: true }
                      : {})}
                  >
                    {campaign.status === "paused"
                      ? "Resume"
                      : campaign.status === "scheduled" || scheduleReady
                        ? "Activate now"
                        : "Activate campaign"}
                  </s-button>
                </s-stack>
              ) : null
            }
            actionNote={actionNote}
            {...(review > 0 && !activatable && campaign.status !== "active"
              ? {
                  reviewAll: {
                    restoreId: CONFIRM_IDS.reviewRestore,
                    releaseId: CONFIRM_IDS.reviewRelease,
                    busy,
                  },
                }
              : {})}
          />

          {catalogue.snapshotAt === null ? (
            <s-banner
              tone="warning"
              heading="The catalogue has not been read yet"
            >
              <s-stack direction="block" gap="small-300">
                <s-paragraph>
                  {catalogue.reading
                    ? "Reading it from Shopify now. The summary appears when it finishes."
                    : "Read the catalogue once to see what this campaign would do."}
                </s-paragraph>
                {!catalogue.reading ? (
                  <s-stack direction="inline">
                    <s-button
                      type="button"
                      onClick={() => submit("refresh-catalogue")}
                      {...(busy ? { disabled: true } : {})}
                    >
                      Read the catalogue
                    </s-button>
                  </s-stack>
                ) : null}
              </s-stack>
            </s-banner>
          ) : null}

          {preview || campaign.status !== "draft" ? (
            <CampaignSummary
              discount={describeFormDiscount(form, campaign.currency)}
              counts={summaryCounts}
              refreshing={live.refreshing}
              note={live.note}
              schedule={schedule}
              conflicts={conflictSummary(form.conflictStrategy, form.priority)}
              variantsHref={variantsHref}
              csvHref={csvHref}
              hasVariants={
                campaign.status !== "draft" || (shown?.variants ?? 0) > 0
              }
              dirty={dirty}
              snapshotAt={
                shown ? (shown.snapshotAt ?? catalogue.snapshotAt) : null
              }
              discountsUnchecked={
                preview?.discounts?.kind === "unavailable"
                  ? preview.discounts.reason
                  : null
              }
            />
          ) : null}

          {shown ? (
            <CampaignWarnings
              conflicts={shown.conflicts}
              scheduledOverlaps={shown.scheduledOverlaps}
              fixedPriceMarkets={shown.fixedPriceMarkets}
              discounts={preview?.discounts ?? null}
              campaignHref={(id) => `/app/sales/${id}`}
            />
          ) : null}
        </s-stack>
      </div>

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
