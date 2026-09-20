import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect } from "react";
import {
  useFetcher,
  useLoaderData,
  useRevalidator,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";
import { z } from "zod";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  countSyncItems,
  getSync,
  listSyncItems,
  requestSyncCancel,
  usageForSync,
} from "~/adapters/db/repositories/translations.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { formatCount } from "~/domain/translations/estimate";
import { formatMicrosUsd } from "~/domain/translations/pricing";
import {
  RESOURCE_TYPE_LABEL,
  SYNC_MODE_LABEL,
  isResourceType,
  type SyncMode,
} from "~/domain/translations/types";
import { ConfirmModal } from "~/web/components/confirm-modal";
import { TranslationsNav } from "~/web/components/translations-nav";
import { formatDateTime } from "~/web/lib/datetime";
import {
  actorFromSession,
  principalFromSession,
} from "~/web/lib/principal.server";
import { redirectWithin } from "~/web/lib/redirects";
import {
  ITEM_STATUS_LABEL,
  SYNC_KIND_LABEL,
  SYNC_STATUS_LABEL,
  TRANSLATION_ROUTES,
  describeResourceId,
  localeLabel,
} from "~/web/lib/translations";

/**
 * One sync (docs/translations.md § Syncs): what it was asked to do, how far
 * it is, what it cost so far, and every resource it touched with the reason
 * for what happened. Failed items link to the editor so the merchant can see
 * the field and decide.
 */
const ITEM_FILTERS = [
  "all",
  "failed",
  "translated",
  "copied",
  "skipped",
] as const;
type ItemFilter = (typeof ITEM_FILTERS)[number];

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const id = String(params.syncId ?? "");
  const sync = await getSync(principal, id);
  if (!sync) throw redirectWithin(request, TRANSLATION_ROUTES.syncs);

  const filterParam = new URL(request.url).searchParams.get("items") ?? "all";
  const filter: ItemFilter = (ITEM_FILTERS as readonly string[]).includes(
    filterParam,
  )
    ? (filterParam as ItemFilter)
    : "all";

  const [items, counts, usage] = await Promise.all([
    listSyncItems(principal, id, {
      status: filter === "all" ? null : filter,
      limit: 200,
    }),
    countSyncItems(principal, id),
    usageForSync(principal, id),
  ]);

  return {
    sync: {
      id: sync.id,
      kind: sync.kind,
      mode: sync.mode,
      status: sync.status,
      sourceLocale: sync.sourceLocale,
      targetLocales: sync.targetLocales,
      resourceTypes: sync.resourceTypes,
      resourceIds: sync.resourceIds,
      totalResources: sync.totalResources,
      doneResources: sync.doneResources,
      translatedFields: sync.translatedFields,
      copiedFields: sync.copiedFields,
      skippedFields: sync.skippedFields,
      failedFields: sync.failedFields,
      cancelRequested: sync.cancelRequested,
      requestedBy: sync.requestedBy,
      lastError: sync.lastError,
      estimate: readEstimate(sync.estimate),
      createdAt: sync.createdAt.toISOString(),
      startedAt: sync.startedAt?.toISOString() ?? null,
      finishedAt: sync.finishedAt?.toISOString() ?? null,
    },
    filter,
    counts,
    items: items.map((item) => ({
      id: item.id,
      resourceId: item.resourceId,
      resourceType: item.resourceType,
      locale: item.locale,
      title: item.title,
      status: item.status,
      fields: item.fields,
      error: item.error,
      detail: describeDetail(item.detail),
      createdAt: item.createdAt.toISOString(),
    })),
    usage: {
      requests: usage.requests,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      cost: formatMicrosUsd(usage.costMicros),
      unpriced: usage.unpriced,
    },
  };
};

const estimateSchema = z
  .object({
    fields: z.number(),
    totalTokens: z.number(),
    costMicros: z.number().nullable().optional(),
  })
  .passthrough();

function readEstimate(
  value: unknown,
): { fields: number; totalTokens: number; cost: string } | null {
  const parsed = estimateSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    fields: parsed.data.fields,
    totalTokens: parsed.data.totalTokens,
    cost:
      typeof parsed.data.costMicros === "number"
        ? formatMicrosUsd(parsed.data.costMicros)
        : "—",
  };
}

const detailSchema = z
  .object({ skipped: z.record(z.string(), z.number()).optional() })
  .passthrough();

/** The skip reasons an item recorded, as a sentence. */
function describeDetail(value: unknown): string | null {
  const parsed = detailSchema.safeParse(value);
  if (!parsed.success || !parsed.data.skipped) return null;
  const parts = Object.entries(parsed.data.skipped)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${count} ${SKIP_LABEL[reason] ?? reason}`);
  return parts.length === 0 ? null : parts.join(", ");
}

const SKIP_LABEL: Record<string, string> = {
  empty_source: "empty",
  not_translatable: "not text",
  identifier: "URL handle",
  up_to_date: "already translated",
  protected_existing: "protected (existing)",
  protected_manual: "protected (edited by a person)",
  same_language: "written in this language",
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const id = String(params.syncId ?? "");
  const intent = String((await request.formData()).get("intent") ?? "");
  if (intent === "cancel") {
    const cancelled = await requestSyncCancel(principal, id);
    if (cancelled)
      await appendEvent(principal, {
        entityType: "translation_sync",
        entityId: id,
        event: "translation_sync.cancel_requested",
        detail: { by: actorFromSession(session) },
      });
    return {
      ok: cancelled,
      message: cancelled
        ? "Stopping after the current page. Everything already written stays."
        : "This sync is not running.",
    };
  }
  return { ok: false, message: "Unknown action." };
};

export default function SyncPage() {
  const { sync, filter, counts, items, usage } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const running = sync.status === "queued" || sync.status === "running";
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") void revalidator.revalidate();
    }, 4000);
    return () => clearInterval(timer);
  }, [running, revalidator]);
  useEffect(() => {
    if (!fetcher.data?.ok) return;
    if (typeof shopify !== "undefined")
      shopify.toast.show(fetcher.data.message);
  }, [fetcher.data]);

  const heading = `${SYNC_KIND_LABEL[sync.kind] ?? sync.kind} · ${formatDateTime(sync.createdAt)}`;
  const progress =
    sync.totalResources > 0
      ? `${sync.doneResources.toLocaleString("en")} of ${sync.totalResources.toLocaleString("en")} resources`
      : `${sync.doneResources.toLocaleString("en")} resources so far`;

  return (
    <s-page heading={heading}>
      <s-link slot="breadcrumb-actions" href={TRANSLATION_ROUTES.syncs}>
        Syncs
      </s-link>
      {running ? (
        <>
          <s-button
            slot="primary-action"
            tone="critical"
            command="--show"
            commandFor="confirm-cancel"
            {...(sync.cancelRequested || fetcher.state !== "idle"
              ? { disabled: true }
              : {})}
          >
            {sync.cancelRequested ? "Stopping…" : "Stop"}
          </s-button>
          <ConfirmModal
            id="confirm-cancel"
            heading="Stop this sync?"
            confirmLabel="Stop"
            onConfirm={() =>
              fetcher.submit({ intent: "cancel" }, { method: "post" })
            }
          >
            <s-paragraph>
              It finishes the page it is on and stops. Every translation already
              written stays in Shopify; nothing is undone.
            </s-paragraph>
          </ConfirmModal>
        </>
      ) : null}

      <s-stack direction="block" gap="large">
        <TranslationsNav current="syncs" />

        {sync.status === "failed" && sync.lastError ? (
          <s-banner tone="critical" heading="This sync did not finish">
            <s-paragraph>{sync.lastError}</s-paragraph>
          </s-banner>
        ) : null}

        <s-section heading="What it does">
          <s-stack direction="block" gap="small-300">
            <s-stack direction="inline" gap="small-300" alignItems="center">
              <s-badge
                {...(sync.status === "failed"
                  ? { tone: "critical" as const }
                  : running
                    ? { tone: "info" as const }
                    : {})}
              >
                {SYNC_STATUS_LABEL[sync.status] ?? sync.status}
              </s-badge>
              <s-text>{progress}</s-text>
            </s-stack>
            <s-text color="subdued">
              {`${SYNC_MODE_LABEL[sync.mode as SyncMode] ?? sync.mode} · from ${sync.sourceLocale === "" ? "the store default" : localeLabel(sync.sourceLocale)} into ${sync.targetLocales.map((l) => localeLabel(l)).join(", ")}`}
            </s-text>
            <s-text color="subdued">
              {sync.resourceIds.length > 0
                ? `${sync.resourceIds.length === 1 ? "One resource" : `${sync.resourceIds.length} resources`}: ${sync.resourceIds.map(describeResourceId).join(", ")}`
                : `Content: ${sync.resourceTypes
                    .map((type) =>
                      isResourceType(type) ? RESOURCE_TYPE_LABEL[type] : type,
                    )
                    .join(", ")}`}
            </s-text>
            <s-text color="subdued">
              {[
                sync.requestedBy
                  ? `Started by ${sync.requestedBy}`
                  : "Started automatically",
                sync.startedAt
                  ? `began ${formatDateTime(sync.startedAt)}`
                  : null,
                sync.finishedAt
                  ? `finished ${formatDateTime(sync.finishedAt)}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </s-text>
          </s-stack>
        </s-section>

        <s-section heading="Result">
          <s-grid
            gridTemplateColumns="@container (inline-size <= 560px) 1fr 1fr, repeat(4, 1fr)"
            gap="base"
          >
            <Stat
              label="Translated"
              value={formatCount(sync.translatedFields)}
            />
            <Stat
              label="Copied from source"
              value={formatCount(sync.copiedFields)}
            />
            <Stat
              label="Left as they were"
              value={formatCount(sync.skippedFields)}
            />
            <Stat label="Failed" value={formatCount(sync.failedFields)} />
          </s-grid>
        </s-section>

        <s-section heading="AI usage">
          <s-stack direction="block" gap="base">
            <s-grid
              gridTemplateColumns="@container (inline-size <= 560px) 1fr 1fr, repeat(4, 1fr)"
              gap="base"
            >
              <Stat label="Requests" value={formatCount(usage.requests)} />
              <Stat
                label="Input tokens"
                value={formatCount(usage.inputTokens)}
              />
              <Stat
                label="Output tokens"
                value={formatCount(usage.outputTokens)}
              />
              <Stat label="Estimated cost" value={usage.cost} />
            </s-grid>
            <s-text color="subdued">
              {sync.estimate
                ? `Estimated beforehand: ${formatCount(sync.estimate.fields)} fields, ${formatCount(sync.estimate.totalTokens)} tokens, ${sync.estimate.cost}. `
                : ""}
              {usage.unpriced > 0
                ? `${usage.unpriced} requests used a model that is not in the pricing table and are not in the cost.`
                : "Cost is estimated from list prices; the provider does not report billed cost."}
            </s-text>
          </s-stack>
        </s-section>

        <s-section heading="Resources">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="small-300">
              {ITEM_FILTERS.map((option) => {
                const count =
                  option === "all"
                    ? Object.values(counts).reduce((a, b) => a + (b ?? 0), 0)
                    : (counts[option] ?? 0);
                const label = `${option === "all" ? "All" : ITEM_STATUS_LABEL[option]} (${count.toLocaleString("en")})`;
                return option === filter ? (
                  <s-text key={option} type="strong">
                    {label}
                  </s-text>
                ) : (
                  <s-link
                    key={option}
                    href={`${TRANSLATION_ROUTES.sync(sync.id)}${option === "all" ? "" : `?items=${option}`}`}
                  >
                    {label}
                  </s-link>
                );
              })}
            </s-stack>
            {items.length === 0 ? (
              <s-text color="subdued">Nothing here yet.</s-text>
            ) : (
              <s-table variant="auto">
                <s-table-header-row>
                  <s-table-header listSlot="primary">Resource</s-table-header>
                  <s-table-header>Language</s-table-header>
                  <s-table-header listSlot="secondary">Outcome</s-table-header>
                  <s-table-header>Detail</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {items.map((item) => (
                    <s-table-row key={item.id}>
                      <s-table-cell>
                        <s-stack direction="block" gap="small-500">
                          <s-link
                            href={`${TRANSLATION_ROUTES.editor}?locale=${encodeURIComponent(item.locale)}&type=${encodeURIComponent(item.resourceType)}&resource=${encodeURIComponent(item.resourceId)}`}
                          >
                            {item.title ?? describeResourceId(item.resourceId)}
                          </s-link>
                          <s-text color="subdued">
                            {isResourceType(item.resourceType)
                              ? RESOURCE_TYPE_LABEL[item.resourceType]
                              : item.resourceType}
                          </s-text>
                        </s-stack>
                      </s-table-cell>
                      <s-table-cell>
                        <s-text>{item.locale}</s-text>
                      </s-table-cell>
                      <s-table-cell>
                        <s-badge
                          {...(item.status === "failed"
                            ? { tone: "critical" as const }
                            : item.status === "skipped"
                              ? {}
                              : { tone: "success" as const })}
                        >
                          {`${ITEM_STATUS_LABEL[item.status] ?? item.status}${item.fields > 0 ? ` · ${item.fields}` : ""}`}
                        </s-badge>
                      </s-table-cell>
                      <s-table-cell>
                        <s-text color="subdued">
                          {item.error ?? item.detail ?? ""}
                        </s-text>
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            )}
            {items.length === 200 ? (
              <s-text color="subdued">Showing the latest 200.</s-text>
            ) : null}
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <s-stack direction="block" gap="small-500">
      <s-text color="subdued">{label}</s-text>
      <s-heading>{value}</s-heading>
    </s-stack>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
