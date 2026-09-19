import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  useLoaderData,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { getCatalogueProduct } from "~/adapters/db/repositories/catalogue.server";
import { eventsForEntity } from "~/adapters/db/repositories/event-log.server";
import { listLiveVariantsForProduct } from "~/adapters/db/repositories/sale-campaign.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { effectiveDiscountBp, isOnSale } from "~/domain/sales/pricing";
import { formatDateTime } from "~/web/lib/datetime";
import { formatMoney } from "~/web/lib/money";
import { principalFromSession } from "~/web/lib/principal.server";
import { STATE_LABEL, formatBasisPoints } from "~/web/lib/sales";

/**
 * One product, as a sale sees it (docs/sale-campaigns.md § UI, brief §22):
 * per variant the price, the compare-at, whether it is on sale, which
 * campaign holds it, the discount, and the price the campaign will put back.
 *
 * From the catalogue snapshot and the campaign rows, never from Shopify on
 * a page load. The product's own page in Shopify is one link away for
 * everything else about it.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const number = String(params.productId ?? "");
  const productId = number.startsWith("gid://")
    ? number
    : `gid://shopify/Product/${number}`;

  const product = await getCatalogueProduct(principal, productId);
  if (!product) throw new Response("Not found", { status: 404 });

  const live = await listLiveVariantsForProduct(principal, productId);
  const held = new Map(live.map((row) => [row.variantId, row]));

  const variants = product.variants.map((variant) => {
    const row = held.get(variant.variantId) ?? null;
    const onSale = isOnSale({
      priceMinor: variant.priceMinor,
      compareAtMinor: variant.compareAtMinor,
    });
    const discountBp =
      variant.compareAtMinor !== null && onSale
        ? effectiveDiscountBp(variant.compareAtMinor, variant.priceMinor)
        : 0;
    return {
      variantId: variant.variantId,
      title: variant.title,
      sku: variant.sku,
      priceMinor: variant.priceMinor,
      compareAtMinor: variant.compareAtMinor,
      currency: variant.currency,
      onSale,
      discountBp,
      campaign: row
        ? {
            id: row.campaignId,
            name: row.campaign.name,
            state: row.state,
            originalPriceMinor: row.originalPriceMinor,
            originalCompareAtMinor: row.originalCompareAtMinor,
            salePriceMinor: row.salePriceMinor,
          }
        : null,
    };
  });

  const events = await Promise.all(
    product.variants.map((variant) =>
      eventsForEntity(principal, "sale_variant", variant.variantId, 10),
    ),
  );

  return {
    product: {
      id: productId,
      number: productId.replace(/^gid:\/\/shopify\/Product\//, ""),
      title: product.title,
      vendor: product.vendor,
      productType: product.productType,
      status: product.status,
      imageUrl: product.imageUrl,
      observedAt: product.observedAt.toISOString(),
    },
    variants,
    events: events
      .flat()
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, 20)
      .map((event) => ({
        id: event.id,
        at: event.at.toISOString(),
        event: event.event,
        variantId: event.entityId,
        detail: event.detail,
      })),
  };
};

const EVENT_COPY: Record<string, string> = {
  "sale_variant.price_changed": "Price changed by a campaign",
  "sale_variant.restored": "Original price put back",
  "sale_variant.apply_failed": "Shopify rejected the sale price",
  "sale_variant.restore_failed": "Shopify rejected the restore",
  "sale_variant.skipped": "Skipped by a campaign",
  "sale_variant.external_change_detected": "Price changed outside the campaign",
  "sale_variant.review_resolved": "Decision made",
  "sale_variant.released": "Released from a campaign",
};

export default function ProductView() {
  const { product, variants, events } = useLoaderData<typeof loader>();

  return (
    <s-page heading={product.title}>
      <s-link slot="breadcrumb-actions" href="/app/products">
        Products
      </s-link>
      <s-button
        slot="secondary-actions"
        href={`shopify://admin/products/${product.number}`}
        target="_blank"
      >
        Open in Shopify
      </s-button>

      <s-stack direction="block" gap="large">
        <s-section>
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-box inlineSize="64px" blockSize="64px">
              {product.imageUrl ? (
                <s-image
                  src={product.imageUrl}
                  alt=""
                  inlineSize="fill"
                  objectFit="contain"
                />
              ) : null}
            </s-box>
            <s-stack direction="block" gap="small-500">
              <s-text color="subdued">
                {[
                  product.vendor,
                  product.productType,
                  product.status?.toLowerCase(),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </s-text>
              <s-text color="subdued">{`As read ${formatDateTime(product.observedAt)}.`}</s-text>
            </s-stack>
          </s-stack>
        </s-section>

        <s-section heading="Prices">
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Variant</s-table-header>
              <s-table-header listSlot="kicker">SKU</s-table-header>
              <s-table-header listSlot="secondary">Price</s-table-header>
              <s-table-header listSlot="secondary">Compare-at</s-table-header>
              <s-table-header listSlot="secondary">Sale</s-table-header>
              <s-table-header listSlot="secondary">Campaign</s-table-header>
              <s-table-header listSlot="secondary">
                Original price
              </s-table-header>
            </s-table-header-row>
            <s-table-body>
              {variants.map((variant) => (
                <s-table-row key={variant.variantId}>
                  <s-table-cell>{variant.title ?? "Default"}</s-table-cell>
                  <s-table-cell>
                    <s-text color="subdued">{variant.sku ?? "—"}</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    {formatMoney(variant.priceMinor, variant.currency)}
                  </s-table-cell>
                  <s-table-cell>
                    {variant.compareAtMinor === null
                      ? "—"
                      : formatMoney(variant.compareAtMinor, variant.currency)}
                  </s-table-cell>
                  <s-table-cell>
                    {variant.onSale
                      ? `-${formatBasisPoints(variant.discountBp)}`
                      : "Not on sale"}
                  </s-table-cell>
                  <s-table-cell>
                    {variant.campaign ? (
                      <s-stack direction="block" gap="small-500">
                        <s-link href={`/app/sales/${variant.campaign.id}`}>
                          {variant.campaign.name}
                        </s-link>
                        {variant.campaign.state !== "applied" ? (
                          <s-text color="subdued">
                            {STATE_LABEL[variant.campaign.state]}
                          </s-text>
                        ) : null}
                      </s-stack>
                    ) : (
                      <s-text color="subdued">—</s-text>
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    {variant.campaign &&
                    variant.campaign.originalPriceMinor !== null
                      ? formatMoney(
                          variant.campaign.originalPriceMinor,
                          variant.currency,
                        )
                      : "—"}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>

        {events.length > 0 ? (
          <s-section heading="Sale history">
            <s-stack direction="block" gap="small-300">
              {events.map((event) => (
                <s-grid
                  key={event.id}
                  gridTemplateColumns="auto 1fr"
                  gap="base"
                >
                  <s-text color="subdued">{formatDateTime(event.at)}</s-text>
                  <s-text>{`${EVENT_COPY[event.event] ?? event.event}${
                    event.variantId
                      ? ` — ${variants.find((v) => v.variantId === event.variantId)?.title ?? ""}`
                      : ""
                  }`}</s-text>
                </s-grid>
              ))}
            </s-stack>
          </s-section>
        ) : null}
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
