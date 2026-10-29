import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useMemo, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { isConfigured } from "~/adapters/ai/openai.server";
import { getAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { listAutofills } from "~/adapters/db/repositories/product-autofill.server";
import { listLanguageSettings } from "~/adapters/db/repositories/translations.server";
import { autofillAvailability } from "~/adapters/products/autofill.server";
import { listShopLocales } from "~/adapters/shopify/locales";
import {
  APPROVE_BATCH,
  approveReviewProducts,
  listReviewProducts,
  type ReviewPage,
} from "~/adapters/shopify/review-products";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { readTranslatableResourcesByIds } from "~/adapters/shopify/translations";
import { translateResourceNow } from "~/adapters/translations/inline.server";
import { startSync } from "~/adapters/translations/syncs.server";
import {
  REVIEW_TAG,
  reviewQuery,
  translationGaps,
  type LocaleGap,
} from "~/domain/export-portal/review";
import { keptKeys } from "~/domain/translations/types";
import { BulkBar, useSelection } from "~/web/components/bulk-selection";
import { SourcesNav } from "~/web/components/sources-nav";
import { ConfirmModal } from "~/web/components/confirm-modal";
import { Dropdown } from "~/web/components/dropdown";
import {
  confidenceLabel,
  confidenceTone,
  isAutofillWorking,
  type AutofillView,
} from "~/web/lib/autofill";
import { autofillListAction } from "~/web/lib/autofill-actions.server";
import { autofillView } from "~/web/lib/autofill.server";
import { formatListDateTime } from "~/web/lib/datetime";
import { useLiveRevalidation, useWatchWindow } from "~/web/lib/live";
import {
  actorFromSession,
  principalFromSession,
} from "~/web/lib/principal.server";
import { SOURCE_ROUTES } from "~/web/lib/sources";
import { readPortal } from "~/web/lib/sources.server";
import { TRANSLATION_ROUTES, localeLabel } from "~/web/lib/translations";

/**
 * Review before publish (docs/sources.md § Review before publish): the new
 * products a source in review mode created as drafts, waiting for a person.
 *
 * The list is Shopify's — drafts carrying the review tag — read as the page
 * opens; nothing about a product under review is stored here. Each row says
 * which of the store's languages still lack a translation, can have them
 * filled by the AI, can have its product type and attributes suggested by
 * the export portal's AI and the suggestions applied (docs/attributes.md
 * § AI autofill), and is approved from here: approving sets it active and
 * takes the tag off, and it leaves the list. A missing translation warns
 * before approving; it does not stop it.
 */
const PAGE_SIZE = 25;
const HELP_MODAL_ID = "about-review";
const APPROVE_MODAL_ID = "approve-review";

interface ActionResult {
  ok: boolean;
  message: string;
  /** Products now live: they leave the list at once (the search catches up later). */
  approvedIds?: string[];
  /** A background translation started: the page follows it closely for a while. */
  translating?: boolean;
}

interface Row {
  id: string;
  legacyId: string;
  title: string;
  vendor: string | null;
  sourceId: string | null;
  sourceName: string | null;
  createdAt: string;
  imageUrl: string | null;
  gaps: LocaleGap[];
  autofill: AutofillView | null;
}

async function targetLocales(admin: Parameters<typeof listShopLocales>[0]) {
  const locales = await listShopLocales(admin);
  if (locales.kind !== "read") return null;
  const primary = locales.locales.find((l) => l.primary) ?? null;
  const targets = locales.locales.filter((l) => l.published && !l.primary);
  return { primary, targets };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const sourceId = url.searchParams.get("source") ?? "";
  const after = url.searchParams.get("after");
  const before = url.searchParams.get("before");

  const [locales, sources, languages, { schema }, autofillReady] =
    await Promise.all([
      targetLocales(admin),
      readPortal(principal, (client) => client.listSources()),
      listLanguageSettings(principal),
      getAttributeSchema(principal),
      autofillAvailability(principal),
    ]);

  let page: ReviewPage | null = null;
  let failure: string | null = null;
  try {
    page = await listReviewProducts(admin, {
      query: reviewQuery({ sourceId, search: q }),
      pageSize: PAGE_SIZE,
      after,
      before,
    });
  } catch (error) {
    failure =
      error instanceof Error
        ? error.message
        : "The products could not be read from Shopify.";
  }

  const sourceNames = new Map(
    sources.kind === "read" ? sources.data.map((s) => [s.id, s.name]) : [],
  );
  const targets = locales?.targets ?? [];
  const keepByLocale = new Map(
    languages.map((l) => [l.locale, keptKeys(l.keepOriginal, "PRODUCT")]),
  );
  const noneKept = new Set<string>();

  let rows: Row[] = [];
  if (page) {
    const resources =
      targets.length > 0 && page.products.length > 0
        ? await readTranslatableResourcesByIds(admin, {
            ids: page.products.map((p) => p.id),
            locales: targets.map((l) => l.locale),
          })
        : [];
    const byId = new Map(resources.map((r) => [r.resourceId, r]));
    const autofills = await listAutofills(
      principal,
      page.products.map((p) => p.id),
    );
    rows = page.products.map((product) => {
      const resource = byId.get(product.id);
      return {
        id: product.id,
        legacyId: product.legacyId,
        title: product.title,
        vendor: product.vendor,
        sourceId: product.sourceId,
        sourceName: product.sourceId
          ? (sourceNames.get(product.sourceId) ?? null)
          : null,
        createdAt: product.createdAt,
        imageUrl: product.imageUrl,
        gaps: resource
          ? translationGaps({
              fields: resource.fields,
              translations: resource.translations,
              locales: targets.map((l) => l.locale),
              kept: (locale) => keepByLocale.get(locale) ?? noneKept,
            })
          : [],
        autofill: autofillView(schema, autofills.get(product.id)),
      };
    });
  }

  return {
    rows,
    failure,
    total: page?.total ?? 0,
    exact: page?.exact ?? true,
    hasNextPage: page?.hasNextPage ?? false,
    hasPreviousPage: page?.hasPreviousPage ?? false,
    startCursor: page?.startCursor ?? null,
    endCursor: page?.endCursor ?? null,
    q,
    sourceId,
    sources:
      sources.kind === "read"
        ? sources.data.map((s) => ({ id: s.id, name: s.name }))
        : [],
    locales: targets.map((l) => ({
      locale: l.locale,
      label: localeLabel(l.locale, l.name),
    })),
    localesUnavailable: locales === null,
    aiConfigured: isConfigured(),
    autofillAvailable: autofillReady.ok
      ? { ok: true as const }
      : { ok: false as const, message: autofillReady.message },
  };
};

function idsFrom(formData: FormData): string[] {
  return String(formData.get("ids") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.startsWith("gid://shopify/Product/"));
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const actor = actorFromSession(session);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const ids = idsFrom(formData);
  if (ids.length === 0)
    return { ok: false, message: "No products chosen." } satisfies ActionResult;

  if (intent === "approve") {
    if (ids.length > APPROVE_BATCH)
      return {
        ok: false,
        message: `Approve at most ${APPROVE_BATCH} at a time.`,
      } satisfies ActionResult;
    const outcomes = await approveReviewProducts(admin, ids);
    const approved = outcomes.filter((o) => o.ok);
    for (const outcome of approved)
      await appendEvent(principal, {
        entityType: "product",
        entityId: outcome.id,
        event: "product.review_approved",
        detail: { title: outcome.title, actor, note: outcome.message },
      });
    const refused = outcomes.filter((o) => !o.ok);
    const approvedIds = approved.map((o) => o.id);
    if (refused.length > 0)
      return {
        ok: approved.length > 0,
        approvedIds,
        message: [
          approved.length > 0
            ? `${approved.length} published.`
            : "Nothing was published.",
          ...refused.map((o) => `${o.title ?? o.id}: ${o.message ?? ""}`),
        ].join(" "),
      } satisfies ActionResult;
    return {
      ok: true,
      message:
        approved.length === 1
          ? `${approved[0]?.title ?? "The product"} is live.`
          : `${approved.length} products are live.`,
      approvedIds,
    } satisfies ActionResult;
  }

  const autofill = await autofillListAction({
    admin,
    principal,
    actor,
    intent,
    ids,
  });
  if (autofill) {
    const result: ActionResult = autofill;
    return result;
  }

  if (intent === "translate") {
    if (!isConfigured())
      return {
        ok: false,
        message: "AI translation is not configured on this server.",
      } satisfies ActionResult;
    const locales = await targetLocales(admin);
    if (!locales?.primary)
      return {
        ok: false,
        message: "Languages could not be read from Shopify.",
      } satisfies ActionResult;
    if (locales.targets.length === 0)
      return {
        ok: false,
        message: "The store has no published language besides its own.",
      } satisfies ActionResult;
    const targets = locales.targets.map((l) => l.locale);

    // One product is translated while the person waits, so the row can
    // show the result; several are a sync, followed on the syncs page.
    if (ids.length === 1) {
      const result = await translateResourceNow(principal, admin, {
        resourceId: ids[0] ?? "",
        resourceType: "PRODUCT",
        primaryLocale: locales.primary.locale,
        targetLocales: targets,
        mode: "missing_outdated",
        requestedBy: actor,
      });
      if (!result.found)
        return {
          ok: false,
          message: "The product could not be read from Shopify.",
        } satisfies ActionResult;
      const { translated, failed } = result.outcome;
      if (failed > 0)
        return {
          ok: false,
          message:
            result.outcome.items.find((item) => item.error)?.error ??
            "Some fields could not be translated.",
        } satisfies ActionResult;
      return {
        ok: true,
        message:
          translated === 0
            ? "Nothing was left to translate."
            : `Translated ${translated} ${translated === 1 ? "field" : "fields"}.`,
      } satisfies ActionResult;
    }

    await startSync(principal, {
      kind: "resource",
      mode: "missing_outdated",
      sourceLocale: locales.primary.locale,
      targetLocales: targets,
      resourceTypes: ["PRODUCT"],
      resourceIds: ids,
      requestedBy: actor,
    });
    return {
      ok: true,
      message: `Translating ${ids.length} products. Their rows update as each one is done.`,
      translating: true,
    } satisfies ActionResult;
  }

  return { ok: false, message: "Unknown action." } satisfies ActionResult;
};

function reviewUrl(params: {
  q?: string;
  source?: string;
  after?: string | null;
  before?: string | null;
}): string {
  const search = new URLSearchParams();
  if (params.q) search.set("q", params.q);
  if (params.source) search.set("source", params.source);
  if (params.after) search.set("after", params.after);
  if (params.before) search.set("before", params.before);
  const query = search.toString();
  return query ? `${SOURCE_ROUTES.review()}?${query}` : SOURCE_ROUTES.review();
}

function editorLink(productId: string, locale: string): string {
  const search = new URLSearchParams({
    locale,
    type: "PRODUCT",
    resource: productId,
    rtype: "PRODUCT",
  });
  return `${TRANSLATION_ROUTES.editor}?${search.toString()}`;
}

function gapSummary(gaps: readonly LocaleGap[]): string {
  return gaps
    .map((gap) =>
      gap.missing > 0
        ? `${gap.locale}: ${gap.missing} missing`
        : `${gap.locale}: ${gap.outdated} outdated`,
    )
    .join(", ");
}

export default function Review() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const result = fetcher.data;
  const busy = fetcher.state !== "idle";
  const [query, setQuery] = useState(data.q);
  const [pendingApprove, setPendingApprove] = useState<string[]>([]);

  // What was approved here leaves the list at once. Shopify's search can
  // still return it for a moment, so it stays hidden until a read no
  // longer does; the count is corrected by what is hidden.
  const [approved, setApproved] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(
    () => data.rows.filter((r) => !approved.has(r.id)),
    [data.rows, approved],
  );
  const total = Math.max(0, data.total - (data.rows.length - rows.length));

  // New drafts arrive and approved ones leave without a reload; after an
  // action the page watches closely until the search has caught up.
  const [watching, watch] = useWatchWindow(
    result?.translating ? 180_000 : 30_000,
  );
  const autofilling = data.rows.some((row) => isAutofillWorking(row.autofill));
  useLiveRevalidation({ active: watching || autofilling });

  const ids = useMemo(() => rows.map((r) => r.id), [rows]);
  const selection = useSelection(ids);
  const rowsById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  useEffect(() => {
    if (!result) return;
    if (result.approvedIds?.length) {
      const done = result.approvedIds;
      setApproved((current) => new Set([...current, ...done]));
    }
    if (!result.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
    // What was acted on is done with; a new result clears the ticks.
    selection.clear();
    watch();
  }, [result]);

  const submit = (body: Record<string, string>) =>
    void fetcher.submit(body, { method: "post" });
  const busyWith = (intent: string, id: string) =>
    busy &&
    fetcher.formData?.get("intent") === intent &&
    fetcher.formData?.get("ids") === id;

  /** Approve now, or ask first when anything chosen is not fully translated. */
  const askApprove = (chosen: string[]) => {
    const incomplete = chosen.filter(
      (id) => (rowsById.get(id)?.gaps.length ?? 0) > 0,
    );
    if (incomplete.length === 0) {
      submit({ intent: "approve", ids: chosen.join(",") });
      return;
    }
    setPendingApprove(chosen);
    const modal = document.getElementById(APPROVE_MODAL_ID) as
      (HTMLElement & { showOverlay?: () => void }) | null;
    modal?.showOverlay?.();
  };
  const pendingIncomplete = pendingApprove
    .map((id) => rowsById.get(id))
    .filter((row): row is Row => Boolean(row && row.gaps.length > 0));

  const filtered = Boolean(data.q || data.sourceId);

  return (
    <s-page heading="Review new products" inlineSize="large">
      <s-link slot="breadcrumb-actions" href={SOURCE_ROUTES.index}>
        Sources
      </s-link>
      <s-button slot="secondary-actions" href="/app/products?view=review">
        All AI suggestions
      </s-button>
      <s-button
        slot="secondary-actions"
        icon="question-circle"
        command="--show"
        commandFor={HELP_MODAL_ID}
      >
        Help
      </s-button>

      <s-modal id={HELP_MODAL_ID} heading="About reviewing new products">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            A source whose new products are set to wait for review creates each
            new product in Shopify as a draft, tagged {REVIEW_TAG}. A draft is
            not shown on any sales channel, so nothing is sold before someone
            has looked at it.
          </s-paragraph>
          <s-paragraph>
            Check each product, fill in its translations, then approve it.
            Approving sets it active and removes the tag; it goes live on the
            sales channels the source publishes to. Later runs update the
            product as usual but never change whether it is live.
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

      <ConfirmModal
        id={APPROVE_MODAL_ID}
        heading={
          pendingApprove.length === 1
            ? "Publish without every translation?"
            : `Publish ${pendingApprove.length} products?`
        }
        confirmLabel="Publish anyway"
        tone="neutral"
        onConfirm={() => {
          if (pendingApprove.length > 0)
            submit({ intent: "approve", ids: pendingApprove.join(",") });
          setPendingApprove([]);
        }}
      >
        <s-paragraph>
          {pendingIncomplete.length === 1
            ? "This product is still missing translations. Customers browsing in those languages see the original text until they are added."
            : `${pendingIncomplete.length} of these products are still missing translations. Customers browsing in those languages see the original text until they are added.`}
        </s-paragraph>
        <s-unordered-list>
          {pendingIncomplete.slice(0, 10).map((row) => (
            <s-list-item key={row.id}>
              {`${row.title} — ${gapSummary(row.gaps)}`}
            </s-list-item>
          ))}
        </s-unordered-list>
      </ConfirmModal>

      <SourcesNav current="review" />

      <s-stack direction="block" gap="base">
        {result && !result.ok ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        {data.failure ? (
          <s-banner tone="critical" heading="The products could not be read">
            <s-paragraph>{data.failure}</s-paragraph>
          </s-banner>
        ) : null}

        {data.localesUnavailable ? (
          <s-banner tone="warning">
            <s-paragraph>
              The store&apos;s languages could not be read from Shopify, so
              translations are not checked.
            </s-paragraph>
          </s-banner>
        ) : null}

        {!data.failure && rows.length === 0 && !filtered ? (
          <s-section>
            <s-box paddingBlock="large-100">
              <s-stack direction="block" gap="small-300" alignItems="center">
                <s-heading>Nothing is waiting for review</s-heading>
                <s-text color="subdued">
                  New products from a source whose new products wait for review
                  appear here as drafts. Every other source publishes them
                  straight away; the setting is on the source.
                </s-text>
              </s-stack>
            </s-box>
          </s-section>
        ) : null}

        {!data.failure && (rows.length > 0 || filtered) ? (
          <s-section accessibilityLabel="Products waiting for review">
            <s-stack direction="block" gap="base">
              <s-stack
                direction="inline"
                gap="base"
                alignItems="center"
                justifyContent="space-between"
              >
                <s-text color="subdued">
                  {`${total.toLocaleString("en")}${data.exact ? "" : "+"} ${total === 1 ? "product is" : "products are"} waiting${filtered ? " that match" : ""}.`}
                </s-text>
                {data.sources.length > 1 ? (
                  <Dropdown
                    name="source"
                    label="Source"
                    hideLabel
                    value={data.sourceId}
                    options={[
                      { value: "", label: "Every source" },
                      ...data.sources.map((source) => ({
                        value: source.id,
                        label: source.name,
                      })),
                    ]}
                    onChange={(value) =>
                      navigate(reviewUrl({ q: data.q, source: value }))
                    }
                  />
                ) : null}
              </s-stack>
              <s-table
                variant="auto"
                {...(busy ? { loading: true } : {})}
                {...(data.hasNextPage || data.hasPreviousPage
                  ? { paginate: true }
                  : {})}
                {...(data.hasNextPage ? { hasNextPage: true } : {})}
                {...(data.hasPreviousPage ? { hasPreviousPage: true } : {})}
                onNextPage={() =>
                  navigate(
                    reviewUrl({
                      q: data.q,
                      source: data.sourceId,
                      after: data.endCursor,
                    }),
                  )
                }
                onPreviousPage={() =>
                  navigate(
                    reviewUrl({
                      q: data.q,
                      source: data.sourceId,
                      before: data.startCursor,
                    }),
                  )
                }
              >
                <s-search-field
                  slot="filters"
                  label="Search products"
                  labelAccessibilityVisibility="exclusive"
                  placeholder="Search products"
                  value={query}
                  onInput={(event) => setQuery(event.currentTarget.value)}
                  onChange={(event) =>
                    navigate(
                      reviewUrl({
                        q: event.currentTarget.value.trim(),
                        source: data.sourceId,
                      }),
                    )
                  }
                />
                <s-table-header-row>
                  <s-table-header listSlot="inline">
                    <s-checkbox
                      label="Select every product on this page"
                      labelAccessibilityVisibility="exclusive"
                      checked={selection.all}
                      onChange={(e) =>
                        selection.toggleAll(e.currentTarget.checked)
                      }
                    />
                  </s-table-header>
                  <s-table-header listSlot="primary">Product</s-table-header>
                  <s-table-header listSlot="secondary">Source</s-table-header>
                  <s-table-header listSlot="labeled">
                    Type and attributes
                  </s-table-header>
                  <s-table-header listSlot="labeled">
                    Translations
                  </s-table-header>
                  <s-table-header listSlot="labeled">Created</s-table-header>
                  <s-table-header listSlot="inline">
                    <s-text accessibilityVisibility="exclusive">Actions</s-text>
                  </s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {rows.map((row) => (
                    <ReviewRow
                      key={row.id}
                      row={row}
                      checked={selection.selected.has(row.id)}
                      onCheck={(on) => selection.toggle(row.id, on)}
                      localesChecked={data.locales.length > 0}
                      canTranslate={data.aiConfigured}
                      canAutofill={data.autofillAvailable.ok}
                      translating={busyWith("translate", row.id)}
                      approving={busyWith("approve", row.id)}
                      autofilling={busyWith("autofill", row.id)}
                      busy={busy}
                      onTranslate={() =>
                        submit({ intent: "translate", ids: row.id })
                      }
                      onAutofill={() =>
                        submit({ intent: "autofill", ids: row.id })
                      }
                      onApprove={() => askApprove([row.id])}
                    />
                  ))}
                </s-table-body>
              </s-table>
              {rows.length === 0 ? (
                <s-text color="subdued">No products match.</s-text>
              ) : null}
              <BulkBar
                count={selection.selected.size}
                noun={selection.selected.size === 1 ? "product" : "products"}
                busy={busy}
                onClear={selection.clear}
                actions={[
                  ...(data.autofillAvailable.ok
                    ? [
                        {
                          label: "Autofill selected",
                          onAct: () =>
                            submit({
                              intent: "autofill",
                              ids: [...selection.selected].join(","),
                            }),
                        },
                      ]
                    : []),
                  ...([...selection.selected].some(
                    (id) => rowsById.get(id)?.autofill?.status === "ready",
                  )
                    ? [
                        {
                          label: "Apply suggestions",
                          onAct: () =>
                            submit({
                              intent: "apply-autofill",
                              ids: [...selection.selected]
                                .filter(
                                  (id) =>
                                    rowsById.get(id)?.autofill?.status ===
                                    "ready",
                                )
                                .join(","),
                            }),
                        },
                      ]
                    : []),
                  ...(data.aiConfigured && data.locales.length > 0
                    ? [
                        {
                          label: "Translate selected",
                          onAct: () =>
                            submit({
                              intent: "translate",
                              ids: [...selection.selected].join(","),
                            }),
                        },
                      ]
                    : []),
                  {
                    label: "Approve selected",
                    primary: true,
                    onAct: () => askApprove([...selection.selected]),
                  },
                ]}
              />
            </s-stack>
          </s-section>
        ) : null}
      </s-stack>
    </s-page>
  );
}

function ReviewRow({
  row,
  checked,
  onCheck,
  localesChecked,
  canTranslate,
  canAutofill,
  translating,
  approving,
  autofilling,
  busy,
  onTranslate,
  onAutofill,
  onApprove,
}: {
  row: Row;
  checked: boolean;
  onCheck: (on: boolean) => void;
  localesChecked: boolean;
  canTranslate: boolean;
  canAutofill: boolean;
  translating: boolean;
  approving: boolean;
  autofilling: boolean;
  busy: boolean;
  onTranslate: () => void;
  onAutofill: () => void;
  onApprove: () => void;
}) {
  const working = isAutofillWorking(row.autofill);
  const ready = row.autofill?.status === "ready";
  const firstGap = row.gaps[0];
  return (
    <s-table-row>
      <s-table-cell>
        <s-checkbox
          label={`Select ${row.title}`}
          labelAccessibilityVisibility="exclusive"
          checked={checked}
          onChange={(e) => onCheck(e.currentTarget.checked)}
        />
      </s-table-cell>
      <s-table-cell>
        <s-stack direction="inline" gap="small-300" alignItems="center">
          <s-box inlineSize="40px" blockSize="40px">
            {row.imageUrl ? (
              <s-image
                src={row.imageUrl}
                alt=""
                inlineSize="fill"
                objectFit="contain"
                loading="lazy"
              />
            ) : null}
          </s-box>
          <s-stack direction="block" gap="none">
            <s-link href={`/app/products/${row.legacyId}`}>{row.title}</s-link>
            {row.vendor ? <s-text color="subdued">{row.vendor}</s-text> : null}
          </s-stack>
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        {row.sourceId ? (
          <s-link href={SOURCE_ROUTES.source(row.sourceId)}>
            {row.sourceName ?? row.sourceId}
          </s-link>
        ) : (
          <s-text color="subdued">—</s-text>
        )}
      </s-table-cell>
      <s-table-cell>
        <AutofillCell view={row.autofill} legacyId={row.legacyId} />
      </s-table-cell>
      <s-table-cell>
        {!localesChecked ? (
          <s-text color="subdued">—</s-text>
        ) : firstGap ? (
          <s-stack direction="block" gap="small-300">
            <s-badge tone="warning">{gapSummary(row.gaps)}</s-badge>
            <s-link href={editorLink(row.id, firstGap.locale)}>
              Edit translations
            </s-link>
          </s-stack>
        ) : (
          <s-badge>Translated</s-badge>
        )}
      </s-table-cell>
      <s-table-cell>
        <s-text color="subdued">{formatListDateTime(row.createdAt)}</s-text>
      </s-table-cell>
      <s-table-cell>
        <s-stack direction="inline" gap="small-300" justifyContent="end">
          {ready ? (
            <s-button href={`/app/products/${row.legacyId}?tab=attributes`}>
              Review
            </s-button>
          ) : null}
          {canAutofill && !ready ? (
            <s-button
              variant="secondary"
              onClick={onAutofill}
              {...(autofilling || working ? { loading: true } : {})}
              {...(busy || working ? { disabled: true } : {})}
            >
              Autofill
            </s-button>
          ) : null}
          {canTranslate && firstGap ? (
            <s-button
              variant="secondary"
              onClick={onTranslate}
              {...(translating ? { loading: true } : {})}
              {...(busy ? { disabled: true } : {})}
            >
              Translate
            </s-button>
          ) : null}
          <s-button
            variant="primary"
            onClick={onApprove}
            {...(approving ? { loading: true } : {})}
            {...(busy ? { disabled: true } : {})}
          >
            Approve
          </s-button>
        </s-stack>
      </s-table-cell>
    </s-table-row>
  );
}

/** What AI autofill holds for the product, and the way to review it. */
/**
 * What AI autofill holds for the product, read in one glance: the type it
 * suggests (its name opens the product to review it), where that type sits,
 * and how many values wait. A badge only when the AI was unsure, since that
 * is the one thing worth stopping for.
 */
function AutofillCell({
  view,
  legacyId,
}: {
  view: AutofillView | null;
  legacyId: string;
}) {
  const reviewHref = `/app/products/${legacyId}?tab=attributes`;
  if (!view || view.status === "discarded")
    return <s-text color="subdued">—</s-text>;
  if (isAutofillWorking(view))
    return (
      <s-stack direction="inline" gap="small-300" alignItems="center">
        <s-spinner size="base" accessibilityLabel="Autofilling" />
        <s-text color="subdued">
          {view.status === "queued" ? "Waiting for the AI" : "Asking the AI"}
        </s-text>
      </s-stack>
    );
  if (view.status === "failed")
    return (
      <s-stack direction="block" gap="none">
        <s-text tone="critical">Autofill failed</s-text>
        <s-text color="subdued">{view.error ?? ""}</s-text>
      </s-stack>
    );

  const path = view.typePath?.split(" › ") ?? [];
  const name = path.at(-1) ?? null;
  // The root every type shares says nothing; the level above the type does.
  const parent = path.slice(path.length > 2 ? 1 : 0, -1).join(" › ");
  const values = view.values.length;
  const valuesText =
    values === 0
      ? "nothing to fill"
      : `${values} ${values === 1 ? "value" : "values"} to fill`;

  if (view.status === "applied")
    return (
      <s-stack direction="block" gap="none">
        <s-text>{name ?? "Applied"}</s-text>
        <s-text color="subdued">Suggestion applied</s-text>
      </s-stack>
    );

  const unsure =
    view.typeOrigin === "suggested" &&
    view.confidence !== null &&
    view.confidence < 0.9;
  return (
    <s-stack direction="block" gap="none">
      <s-stack direction="inline" gap="small-300" alignItems="center">
        {name ? (
          <s-link href={reviewHref}>{name}</s-link>
        ) : (
          <s-link href={reviewHref}>No type fits</s-link>
        )}
        {unsure ? (
          <s-badge tone={confidenceTone(view.confidence)}>
            {confidenceLabel(view.confidence) ?? ""}
          </s-badge>
        ) : null}
      </s-stack>
      <s-text color="subdued">
        {[
          parent || null,
          view.typeOrigin === "kept" ? "Type already set" : "AI suggestion",
          name ? valuesText : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </s-text>
    </s-stack>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
