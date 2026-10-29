import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useMemo, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  useNavigation,
  useSearchParams,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { getAttributeSchema } from "~/adapters/db/repositories/attribute-schema.server";
import {
  countReadyAutofills,
  listAutofills,
  readyAutofillProductIds,
} from "~/adapters/db/repositories/product-autofill.server";
import {
  autofillAvailability,
  requestApplyAutofill,
  requestAutofillAll,
} from "~/adapters/products/autofill.server";

import {
  PRODUCT_STATUS_FILTERS,
  catalogueFacetOptions,
  listCatalogueProducts,
  type ProductListRow,
  type ProductStatusFilter,
} from "~/adapters/db/repositories/product-workspace.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import {
  DEFAULT_PRODUCT_SORT,
  PRODUCT_FACETS,
  hasProductFilters,
  parseProductFilters,
  parseProductSort,
  type ProductColumn,
  type ProductSort,
} from "~/domain/products/product-list";
import {
  COLUMN_LABEL,
  ProductFilterChips,
  ProductSearchBar,
  ProductViewOptions,
  useProductColumns,
} from "~/web/components/product-list-view";
import { BulkBar, useSelection } from "~/web/components/bulk-selection";
import { ConfirmModal } from "~/web/components/confirm-modal";
import {
  autofillSummary,
  isAutofillWorking,
  type AutofillView,
} from "~/web/lib/autofill";
import { autofillListAction } from "~/web/lib/autofill-actions.server";
import { autofillView } from "~/web/lib/autofill.server";
import { countOf } from "~/web/lib/attributes";
import { formatListDateTime } from "~/web/lib/datetime";
import { useLiveRevalidation } from "~/web/lib/live";
import { incompleteRigProducts } from "~/web/lib/rig-readiness.server";
import { formatMoney } from "~/web/lib/money";
import {
  actorFromSession,
  principalFromSession,
} from "~/web/lib/principal.server";
import { STATUS_LABEL, productPath } from "~/web/lib/product-workspace";

/**
 * Products: the way into each product's workspace (docs/architecture.md
 * § Product workspace). A list of the catalogue snapshot — searched by
 * title, vendor, type or SKU, filtered by status and by vendor, product
 * type, category or tag, sorted, with the columns each viewer chooses —
 * where opening a row opens the product here rather than in Shopify's
 * editor. Sort and filters are in the address; the column layout is the
 * viewer's own, kept in their browser.
 *
 * It reads the snapshot, not Shopify, so it answers at once for any
 * catalogue size; the snapshot follows every `products/update` and is read
 * whole every night. The workspace itself reads the product live.
 */

const PAGE_SIZE = 50;

function statusFilter(value: string | null): ProductStatusFilter {
  return (PRODUCT_STATUS_FILTERS as readonly string[]).includes(value ?? "")
    ? (value as ProductStatusFilter)
    : "all";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const status = statusFilter(url.searchParams.get("status"));
  const hideArchived = url.searchParams.get("archived") === "hide";
  const sort = parseProductSort(
    url.searchParams.get("sort"),
    url.searchParams.get("dir"),
  );
  const filters = parseProductFilters((facet) =>
    url.searchParams.getAll(facet),
  );
  const page = Math.max(
    1,
    Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1,
  );

  // The AI review view: products whose autofill suggestions wait for a
  // person (docs/attributes.md § AI autofill).
  const review = url.searchParams.get("view") === "review";
  const [readyIds, { schema }, autofillReady] = await Promise.all([
    readyAutofillProductIds(principal),
    getAttributeSchema(principal),
    autofillAvailability(principal),
  ]);

  // Rig readiness: only the products of one rig type that still lack data
  // (docs/attributes.md, Rig readiness), the same ones the count was made of.
  const incompleteType = url.searchParams.get("incomplete");
  const incompleteIds = incompleteType
    ? await incompleteRigProducts(principal, schema, incompleteType)
    : null;

  const [result, facetOptions] = await Promise.all([
    listCatalogueProducts(principal, {
      q,
      status: review || incompleteIds ? "all" : status,
      hideArchived: review || incompleteIds ? false : hideArchived,
      filters,
      sort,
      page,
      pageSize: PAGE_SIZE,
      ...(review
        ? { productIds: readyIds }
        : incompleteIds
          ? { productIds: incompleteIds }
          : {}),
    }),
    catalogueFacetOptions(principal),
  ]);
  const autofills = await listAutofills(
    principal,
    result.rows.map((row) => row.productId),
  );
  return {
    review,
    incomplete:
      incompleteIds && incompleteType
        ? { type: incompleteType, count: incompleteIds.length }
        : null,
    reviewCount: readyIds.length,
    autofillAvailable: autofillReady.ok,
    q,
    status,
    hideArchived,
    sort,
    filters,
    facetOptions,
    page,
    total: result.total,
    pages: Math.max(1, Math.ceil(result.total / PAGE_SIZE)),
    snapshotAt: result.snapshotAt?.toISOString() ?? null,
    rows: result.rows.map((row) => ({
      ...row,
      updatedAt: row.updatedAt?.toISOString() ?? null,
      autofill: autofillView(schema, autofills.get(row.productId)),
    })),
  };
};

/**
 * Autofill and apply on the selected products, as on Sources › Review; or
 * autofill every product the AI has not been asked about yet.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  if (formData.get("intent") === "apply-all") {
    const principal = principalFromSession(session);
    const waiting = await countReadyAutofills(principal);
    if (waiting === 0)
      return { ok: false, message: "No suggestions are waiting." };
    await requestApplyAutofill(principal, actorFromSession(session), null);
    return {
      ok: true,
      background: true,
      message: `Applying all ${waiting} suggestions in the background. Each product leaves AI review as it is applied.`,
    };
  }
  if (formData.get("intent") === "autofill-all") {
    const principal = principalFromSession(session);
    const available = await autofillAvailability(principal);
    if (!available.ok) return { ok: false, message: available.message };
    const count = await requestAutofillAll(
      principal,
      actorFromSession(session),
      {
        fillAttributes: true,
        autoApply: formData.get("autoApply") === "true",
      },
    );
    return count === 0
      ? {
          ok: false,
          message:
            "The AI has already been asked about every product. Use Autofill with AI on selected products to ask again.",
        }
      : {
          ok: true,
          message: `Asking the AI about ${count} ${count === 1 ? "product" : "products"}, ten at a time. Each shows its suggestion when it is ready.`,
        };
  }
  const ids = String(formData.get("ids") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.startsWith("gid://shopify/Product/"));
  if (ids.length === 0) return { ok: false, message: "No products chosen." };
  return (
    (await autofillListAction({
      admin,
      principal: principalFromSession(session),
      actor: actorFromSession(session),
      intent: String(formData.get("intent") ?? ""),
      ids,
    })) ?? { ok: false, message: "Unknown action." }
  );
};

const FILTER_LABEL: Record<ProductStatusFilter, string> = {
  all: "All",
  active: "Active",
  draft: "Draft",
  archived: "Archived",
};

type ListRow = Omit<ProductListRow, "updatedAt"> & {
  updatedAt: string | null;
  autofill: AutofillView | null;
};

/** What AI autofill holds for a row, under its title. */
function AutofillBadge({ view }: { view: AutofillView | null }) {
  if (!view) return null;
  if (isAutofillWorking(view))
    return <s-text color="subdued">AI is looking at it…</s-text>;
  if (view.status === "ready")
    return (
      <s-text color="subdued">{`AI suggestion: ${autofillSummary(view)}`}</s-text>
    );
  if (view.status === "failed")
    return <s-text tone="critical">AI suggestion failed</s-text>;
  return null;
}

function priceText(row: ListRow): string {
  if (row.minPriceMinor === null || !row.currency) return "—";
  return row.minPriceMinor === row.maxPriceMinor
    ? formatMoney(row.minPriceMinor, row.currency)
    : `${formatMoney(row.minPriceMinor, row.currency)} – ${formatMoney(row.maxPriceMinor ?? row.minPriceMinor, row.currency)}`;
}

/** How each column's heading lays out in the narrow, list form of the table. */
const COLUMN_HEADER: Record<
  ProductColumn,
  {
    listSlot: "inline" | "secondary" | "labeled";
    format?: "numeric" | "currency";
  }
> = {
  status: { listSlot: "inline" },
  category: { listSlot: "labeled" },
  productType: { listSlot: "secondary" },
  vendor: { listSlot: "labeled" },
  variants: { listSlot: "labeled", format: "numeric" },
  price: { listSlot: "labeled", format: "currency" },
  tags: { listSlot: "labeled" },
  updated: { listSlot: "labeled" },
};

function ColumnCell({ column, row }: { column: ProductColumn; row: ListRow }) {
  switch (column) {
    case "status":
      return (
        <s-table-cell>
          <s-badge
            {...(row.status === "DRAFT" ? { tone: "info" as const } : {})}
          >
            {STATUS_LABEL[row.status ?? ""] ?? "Unknown"}
          </s-badge>
        </s-table-cell>
      );
    case "category":
      return <s-table-cell>{row.categoryName || "—"}</s-table-cell>;
    case "productType":
      return <s-table-cell>{row.productType || "—"}</s-table-cell>;
    case "vendor":
      return <s-table-cell>{row.vendor || "—"}</s-table-cell>;
    case "variants":
      return <s-table-cell>{row.variants}</s-table-cell>;
    case "price":
      return <s-table-cell>{priceText(row)}</s-table-cell>;
    case "tags":
      return (
        <s-table-cell>
          {row.tags.length > 0 ? row.tags.join(", ") : "—"}
        </s-table-cell>
      );
    case "updated":
      return (
        <s-table-cell>
          {row.updatedAt ? formatListDateTime(row.updatedAt) : "—"}
        </s-table-cell>
      );
  }
}

/** The default sort stays out of the address. */
function sortParams(sort: ProductSort): {
  sort: string | null;
  dir: string | null;
} {
  const isDefault =
    sort.key === DEFAULT_PRODUCT_SORT.key &&
    sort.direction === DEFAULT_PRODUCT_SORT.direction;
  return isDefault
    ? { sort: null, dir: null }
    : { sort: sort.key, dir: sort.direction };
}

export default function Products() {
  const {
    q,
    status,
    hideArchived,
    sort,
    filters,
    facetOptions,
    page,
    pages,
    total,
    rows,
    snapshotAt,
    review,
    incomplete,
    reviewCount,
    autofillAvailable,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const acting = fetcher.state !== "idle";
  const result = fetcher.data;
  const ids = useMemo(() => rows.map((row) => row.productId), [rows]);
  const selection = useSelection(ids);
  const readyById = useMemo(
    () =>
      new Set(
        rows
          .filter((row) => row.autofill?.status === "ready")
          .map((row) => row.productId),
      ),
    [rows],
  );
  // A background apply empties AI review a few products at a time.
  const applying =
    fetcher.data?.ok === true &&
    "background" in fetcher.data &&
    fetcher.data.background === true &&
    reviewCount > 0;
  useLiveRevalidation({
    active: applying || rows.some((row) => isAutofillWorking(row.autofill)),
  });
  useEffect(() => {
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
    selection.clear();
  }, [result]);
  const act = (intent: string, chosen: readonly string[]) =>
    void fetcher.submit({ intent, ids: chosen.join(",") }, { method: "post" });
  const [columns, setColumns] = useProductColumns();
  const visibleColumns = columns
    .filter((column) => column.visible)
    .map((column) => column.key);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const [search, setSearch] = useState(q);
  useEffect(() => setSearch(q), [q]);

  const listQuery = params.toString();
  const go = (patch: Record<string, string | readonly string[] | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      next.delete(key);
      if (typeof value === "string") {
        if (value !== "") next.set(key, value);
      } else if (value) {
        for (const item of value) next.append(key, item);
      }
    }
    void navigate(
      `/app/products${next.toString() ? `?${next.toString()}` : ""}`,
    );
  };

  // A search is sent once typing pauses, not on every key — and not while
  // another change to the list is on its way, whose address it would undo.
  const idle = navigation.state === "idle";
  useEffect(() => {
    if (search.trim() === q || !idle) return;
    const timer = setTimeout(() => go({ q: search.trim(), page: null }), 350);
    return () => clearTimeout(timer);
  }, [search, q, idle]);

  // In the AI review view a product opens on its suggestion.
  const open = (productId: string) => {
    const path = productPath(productId, review ? "attributes" : undefined);
    const joiner = path.includes("?") ? "&" : "?";
    void navigate(
      listQuery
        ? `${path}${joiner}list=${encodeURIComponent(`?${listQuery}`)}`
        : path,
    );
  };
  const loading =
    navigation.state === "loading" &&
    navigation.location.pathname === "/app/products";

  return (
    <s-page heading="Products" inlineSize="large">
      {autofillAvailable ? (
        <s-button
          slot="secondary-actions"
          icon="wand"
          command="--show"
          commandFor="autofill-all"
        >
          Autofill all with AI
        </s-button>
      ) : null}
      {result && !result.ok ? (
        <s-banner tone="critical" heading="That did not work">
          <s-paragraph>{result.message}</s-paragraph>
        </s-banner>
      ) : null}
      <s-section padding="none" accessibilityLabel="Products">
        <s-stack direction="block" gap="none">
          <s-box
            paddingInline="base"
            paddingBlockStart="base"
            paddingBlockEnd="small-200"
          >
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="small-300" alignItems="center">
                {(Object.keys(FILTER_LABEL) as ProductStatusFilter[]).map(
                  (key) =>
                    key === status && !review ? (
                      <s-button
                        key={key}
                        variant="secondary"
                        accessibilityLabel={`${FILTER_LABEL[key]}, current view`}
                      >
                        {FILTER_LABEL[key]}
                      </s-button>
                    ) : (
                      <s-button
                        key={key}
                        variant="tertiary"
                        onClick={() =>
                          go({
                            status: key === "all" ? null : key,
                            view: null,
                            page: null,
                          })
                        }
                      >
                        {FILTER_LABEL[key]}
                      </s-button>
                    ),
                )}
                {reviewCount > 0 || review ? (
                  review ? (
                    <s-button
                      variant="secondary"
                      accessibilityLabel="AI review, current view"
                    >
                      {`AI review (${reviewCount})`}
                    </s-button>
                  ) : (
                    <s-button
                      variant="tertiary"
                      onClick={() =>
                        go({ view: "review", status: null, page: null })
                      }
                    >
                      {`AI review (${reviewCount})`}
                    </s-button>
                  )
                ) : null}
              </s-stack>
              <s-grid
                gridTemplateColumns="1fr auto"
                gap="small-300"
                alignItems="center"
              >
                <ProductSearchBar
                  search={search}
                  onSearchChange={setSearch}
                  filters={filters}
                  options={facetOptions}
                  onFilterChange={(facet, values, clearSearch) => {
                    if (clearSearch) setSearch("");
                    go({
                      [facet]: values,
                      ...(clearSearch ? { q: null } : {}),
                      page: null,
                    });
                  }}
                />
                <ProductViewOptions
                  sort={sort}
                  onSortChange={(next) =>
                    go({ ...sortParams(next), page: null })
                  }
                  hideArchived={hideArchived}
                  onHideArchivedChange={(hide) =>
                    go({ archived: hide ? "hide" : null, page: null })
                  }
                  hideArchivedDisabled={status !== "all"}
                  columns={columns}
                  onColumnsChange={setColumns}
                />
              </s-grid>
              {review ? (
                <s-grid
                  gridTemplateColumns="1fr auto"
                  gap="base"
                  alignItems="center"
                >
                  <s-text color="subdued">
                    Products whose AI suggestion waits for a person. Open one to
                    check it and apply it, then move on to the next; or select
                    several, or all, and apply their suggestions as they are.
                  </s-text>
                  {reviewCount > 0 ? (
                    <s-button
                      command="--show"
                      commandFor="apply-all"
                      disabled={applying}
                    >
                      {applying ? "Applying…" : `Apply all (${reviewCount})`}
                    </s-button>
                  ) : null}
                </s-grid>
              ) : null}
              {incomplete ? (
                <s-grid
                  gridTemplateColumns="1fr auto"
                  gap="base"
                  alignItems="center"
                >
                  <s-text color="subdued">
                    {`${countOf(incomplete.count, "product")} still missing data the rig builder needs. Open one to fill it in.`}
                  </s-text>
                  <s-link href="/app/products">Show all products</s-link>
                </s-grid>
              ) : null}
              <ProductFilterChips
                filters={filters}
                options={facetOptions}
                onChange={(facet, values) =>
                  go({ [facet]: values, page: null })
                }
                onClearAll={() =>
                  go({
                    ...Object.fromEntries(
                      PRODUCT_FACETS.map((facet) => [facet, null]),
                    ),
                    page: null,
                  })
                }
              />
            </s-stack>
          </s-box>

          {rows.length === 0 ? (
            <s-box padding="base">
              <s-text color="subdued">
                {review
                  ? "No AI suggestions are waiting. Autofill products from this list, from a product's Attributes tab, or from Sources › Review."
                  : total === 0 &&
                      q === "" &&
                      status === "all" &&
                      !hideArchived &&
                      !hasProductFilters(filters)
                    ? "The catalogue has not been read yet. It is read every night, and after a sale campaign asks for it."
                    : "No products match."}
              </s-text>
            </s-box>
          ) : (
            <s-table variant="auto" {...(loading ? { loading: true } : {})}>
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
                {visibleColumns.map((column) => {
                  const { listSlot, format } = COLUMN_HEADER[column];
                  return (
                    <s-table-header
                      key={column}
                      listSlot={listSlot}
                      {...(format ? { format } : {})}
                    >
                      {COLUMN_LABEL[column]}
                    </s-table-header>
                  );
                })}
              </s-table-header-row>
              <s-table-body>
                {rows.map((row) => (
                  <s-table-row
                    key={row.productId}
                    clickDelegate={`open-${row.productId}`}
                  >
                    <s-table-cell>
                      <s-checkbox
                        label={`Select ${row.title}`}
                        labelAccessibilityVisibility="exclusive"
                        checked={selection.selected.has(row.productId)}
                        onChange={(e) =>
                          selection.toggle(
                            row.productId,
                            e.currentTarget.checked,
                          )
                        }
                      />
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack
                        direction="inline"
                        gap="small-300"
                        alignItems="center"
                      >
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
                        <s-stack direction="block" gap="small-500">
                          <s-link
                            id={`open-${row.productId}`}
                            href={productPath(row.productId)}
                            onClick={(event) => {
                              event.preventDefault();
                              open(row.productId);
                            }}
                          >
                            {row.title}
                          </s-link>
                          {row.sku ? (
                            <s-text color="subdued">{row.sku}</s-text>
                          ) : null}
                          <AutofillBadge view={row.autofill} />
                        </s-stack>
                      </s-stack>
                    </s-table-cell>
                    {visibleColumns.map((column) => (
                      <ColumnCell key={column} column={column} row={row} />
                    ))}
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}

          <s-box paddingInline="base" paddingBlock="small-200">
            <s-grid
              gridTemplateColumns="1fr auto"
              gap="base"
              alignItems="center"
            >
              <s-text color="subdued">
                {`${total} ${total === 1 ? "product" : "products"}${
                  snapshotAt
                    ? ` · catalogue read ${formatListDateTime(snapshotAt)}`
                    : ""
                }`}
              </s-text>
              {pages > 1 ? (
                <s-stack direction="inline" gap="small-300" alignItems="center">
                  <s-button
                    icon="chevron-left"
                    accessibilityLabel="Previous page"
                    onClick={() =>
                      go({ page: page - 1 <= 1 ? null : String(page - 1) })
                    }
                    {...(page <= 1 ? { disabled: true } : {})}
                  />
                  <s-text color="subdued">{`${page} of ${pages}`}</s-text>
                  <s-button
                    icon="chevron-right"
                    accessibilityLabel="Next page"
                    onClick={() => go({ page: String(page + 1) })}
                    {...(page >= pages ? { disabled: true } : {})}
                  />
                </s-stack>
              ) : null}
            </s-grid>
          </s-box>
        </s-stack>
      </s-section>
      <BulkBar
        count={selection.selected.size}
        noun={selection.selected.size === 1 ? "product" : "products"}
        busy={acting}
        onClear={selection.clear}
        actions={[
          ...([...selection.selected].some((id) => readyById.has(id))
            ? [
                {
                  label: "Apply suggestions",
                  primary: true,
                  onAct: () =>
                    act(
                      "apply-autofill",
                      [...selection.selected].filter((id) => readyById.has(id)),
                    ),
                },
              ]
            : []),
          ...(autofillAvailable
            ? [
                {
                  label: "Autofill with AI",
                  onAct: () => act("autofill", [...selection.selected]),
                },
              ]
            : []),
        ]}
      />
      <ConfirmModal
        id="apply-all"
        heading={`Apply all ${reviewCount} suggestions?`}
        confirmLabel="Apply all"
        tone="neutral"
        onConfirm={() =>
          void fetcher.submit({ intent: "apply-all" }, { method: "post" })
        }
      >
        <s-paragraph>
          Every suggestion waiting in AI review is applied as it is: the product
          type is set and the suggested values fill fields that are still empty.
          Nothing already filled is overwritten. It runs in the background, ten
          products at a time; you can leave this page.
        </s-paragraph>
      </ConfirmModal>
      <AutofillAllModal
        onConfirm={(autoApply) =>
          void fetcher.submit(
            { intent: "autofill-all", autoApply: String(autoApply) },
            { method: "post" },
          )
        }
      />
    </s-page>
  );
}

/**
 * "Autofill all": every product the AI has not been asked about yet, and
 * whether a confident suggestion is applied at once or waits on AI review.
 */
function AutofillAllModal({
  onConfirm,
}: {
  onConfirm: (autoApply: boolean) => void;
}) {
  const [autoApply, setAutoApply] = useState(true);
  return (
    <s-modal id="autofill-all" heading="Autofill all products with AI">
      <s-stack direction="block" gap="base">
        <s-paragraph>
          The AI suggests a product type and fills empty attributes for every
          product it has not been asked about yet, ten at a time. Products with
          a suggestion waiting, applied or discarded are skipped; ones that
          failed are asked again. A large catalogue takes a while; you can leave
          this page.
        </s-paragraph>
        <s-checkbox
          label="Apply automatically when the AI is confident"
          details="80% sure of the type or more. Anything less sure waits in AI review."
          checked={autoApply}
          onChange={(event) => setAutoApply(event.currentTarget.checked)}
        />
      </s-stack>
      <s-button
        slot="primary-action"
        variant="primary"
        command="--hide"
        commandFor="autofill-all"
        onClick={() => onConfirm(autoApply)}
      >
        Autofill all
      </s-button>
      <s-button
        slot="secondary-actions"
        command="--hide"
        commandFor="autofill-all"
      >
        Cancel
      </s-button>
    </s-modal>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
