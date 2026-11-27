import { boundary } from "@shopify/shopify-app-react-router/server";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { prisma } from "~/adapters/db/client.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  getFixedPartner,
  getPartnerDocumentSettings,
  saveFixedPartner,
  savePartnerDocumentSettings,
} from "~/adapters/db/repositories/sales-order-setting.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import {
  parseDiscountPercent,
  partnerOverrideSchema,
} from "~/domain/orders/partner";
import {
  documentTitleFor,
  unknownPlaceholders,
  type OrderReferenceContext,
} from "~/domain/orders/reference";
import { PatternEditor } from "~/web/components/pattern-editor";
import {
  ORDER_REFERENCE_REGISTRY,
  orderReferenceRows,
} from "~/web/lib/order-reference-fields";
import { principalFromSession } from "~/web/lib/principal.server";

/**
 * One MetaKocka customer for every sales order (`choosePartner` in
 * `domain/orders/partner`).
 *
 * For a shop that books its web sales against a single partner in MetaKocka
 * instead of creating one per Shopify buyer. A partner entered on one order
 * still wins, the receiver stays the Shopify shipping address, and VAT is
 * decided from the order's own countries, so OSS is unaffected.
 *
 * Applies to orders whose partner has not been resolved yet; an order already
 * filed against its own customer keeps it.
 *
 * Partner pricing and the sales order title are saved from their own form, so
 * saving either never clears the partner or the MetaKocka ids it resolved to.
 * With a fixed partner and a pricelist, every order becomes a wholesale sale
 * to that partner (`jobs/partner-pricing`, docs/architecture.md § Who an order
 * is filed against).
 */

/** MetaKocka pricelist codes are short; anything longer is a typo. */
const MAX_PRICELIST_CODE_LENGTH = 30;

type ActionResult = { ok: boolean; message: string };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const [fixed, documents, recent] = await Promise.all([
    getFixedPartner(principal),
    getPartnerDocumentSettings(principal),
    // One of the merchant's own orders for the title preview; none, no preview.
    prisma.order.findFirst({
      where: { shop: { domain: session.shop }, shopifyDeletedAt: null },
      orderBy: { receivedAt: "desc" },
      select: { shopifyOrderId: true, shopifyOrderNumber: true },
    }),
  ]);
  return {
    partner: fixed?.partner ?? null,
    resolved: fixed?.mkId !== null && fixed?.mkId !== undefined,
    pricelistCode: documents.pricelistCode,
    discountPercent: documents.discountPercent,
    titleTemplate: documents.titleTemplate,
    sample: recent
      ? {
          id: recent.shopifyOrderId,
          number: recent.shopifyOrderNumber,
          name: `#${recent.shopifyOrderNumber}`,
        }
      : null,
  };
};

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionResult> => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "documents") {
    const pricelistCode =
      String(formData.get("pricelistCode") ?? "").trim() || null;
    const discount = parseDiscountPercent(
      String(formData.get("discountPercent") ?? ""),
    );
    const titleTemplate =
      String(formData.get("titleTemplate") ?? "").trim() || null;

    if (pricelistCode && pricelistCode.length > MAX_PRICELIST_CODE_LENGTH) {
      return {
        ok: false,
        message: `A MetaKocka pricelist code is at most ${MAX_PRICELIST_CODE_LENGTH} characters. Enter the code, such as 4, not the pricelist's name.`,
      };
    }
    if (discount === "invalid") {
      return {
        ok: false,
        message:
          "Enter the discount as a percentage from 0 to 99.99, such as 20, or leave it empty.",
      };
    }
    if (discount !== null && !pricelistCode) {
      return {
        ok: false,
        message:
          "Enter the pricelist too. The discount applies to the pricelist's prices.",
      };
    }
    const badFields = titleTemplate ? unknownPlaceholders(titleTemplate) : [];
    if (badFields.length > 0) {
      return {
        ok: false,
        message: `${badFields.map((field) => `{${field}}`).join(", ")} ${badFields.length === 1 ? "is not a field" : "are not fields"} this app can fill in.`,
      };
    }

    await savePartnerDocumentSettings(principal, {
      pricelistCode,
      discountPercent: discount,
      titleTemplate,
    });
    await appendEvent(principal, {
      entityType: "sales_order_setting",
      event: "orders.partner_pricing_saved",
      detail: { pricelistCode, discountPercent: discount, titleTemplate },
    });
    return {
      ok: true,
      message: pricelistCode
        ? `Saved. Orders filed against the MetaKocka customer are priced from pricelist ${pricelistCode}.`
        : "Saved.",
    };
  }

  if (intent === "clear") {
    await saveFixedPartner(principal, null);
    await appendEvent(principal, {
      entityType: "sales_order_setting",
      event: "orders.fixed_partner_cleared",
    });
    return {
      ok: true,
      message:
        "Removed. New orders are filed against their own Shopify customer again.",
    };
  }

  const parsed = partnerOverrideSchema.safeParse({
    customer: formData.get("customer") ?? "",
    street: formData.get("street") || null,
    postNumber: formData.get("postNumber") || null,
    place: formData.get("place") || null,
    country: formData.get("country") || null,
    taxNumber: formData.get("taxNumber") || null,
    email: formData.get("email") || null,
    phone: formData.get("phone") || null,
    isBusiness: formData.get("isBusiness") === "on",
  });
  if (!parsed.success) {
    return {
      ok: false,
      message:
        "A customer or company name is required. MetaKocka will not accept a sales order without one.",
    };
  }
  if (!parsed.data.street) {
    return {
      ok: false,
      message:
        "Enter the street too. MetaKocka needs a name and a street to find or create the partner.",
    };
  }

  await saveFixedPartner(principal, parsed.data);
  await appendEvent(principal, {
    entityType: "sales_order_setting",
    event: "orders.fixed_partner_saved",
    detail: { customer: parsed.data.customer },
  });
  return {
    ok: true,
    message: `Saved. New orders are filed against ${parsed.data.customer} in MetaKocka.`,
  };
};

export default function FixedCustomer() {
  const {
    partner,
    resolved,
    pricelistCode,
    discountPercent,
    titleTemplate,
    sample,
  } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";

  // What is saved comes back as what was typed, so the field keeps its state.
  const [title, setTitle] = useState(titleTemplate ?? "");

  const sampleContext: OrderReferenceContext | null = useMemo(
    () =>
      sample
        ? {
            name: sample.name,
            number: sample.number,
            id: sample.id,
            customerEmail: null,
          }
        : null,
    [sample],
  );
  const titleRows = useCallback(
    (query: string) => orderReferenceRows(query, sampleContext),
    [sampleContext],
  );
  const badTitleFields = unknownPlaceholders(title);
  const titlePreview = sampleContext
    ? documentTitleFor(title, sampleContext)
    : null;

  useEffect(() => {
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [result]);

  return (
    <s-page heading="One customer for every order">
      <s-link slot="breadcrumb-actions" href="/app/orders/settings">
        Order settings
      </s-link>

      <s-stack direction="block" gap="large">
        {result && !result.ok ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        <s-section heading="MetaKocka customer">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              {partner
                ? `Every new sales order is filed against ${partner.customer} in MetaKocka, not the Shopify customer.`
                : "Off. Each sales order is filed against its own Shopify customer."}
            </s-paragraph>
            <s-text color="subdued">
              Unless wholesale pricing is on below, the delivery address on each
              sales order is still the order&apos;s Shopify shipping address,
              and VAT (including OSS) is still decided by the customer&apos;s
              country. Customer details entered on a single order still win.
              Orders already in MetaKocka keep the customer they have.
              {partner
                ? resolved
                  ? " This customer has been found in MetaKocka."
                  : " It is looked up in MetaKocka, or created there, with the next order."
                : ""}
            </s-text>

            <Form method="post">
              <input type="hidden" name="intent" value="save" />
              <s-stack direction="block" gap="base">
                <s-box maxInlineSize="520px">
                  <s-text-field
                    name="customer"
                    label="Customer or company name"
                    defaultValue={partner?.customer ?? ""}
                    required
                    details="Use the name exactly as the partner is called in MetaKocka, so it is found rather than created again."
                  />
                </s-box>

                <s-grid gridTemplateColumns="2fr 1fr" gap="base">
                  <s-text-field
                    name="street"
                    label="Street and number"
                    defaultValue={partner?.street ?? ""}
                    required
                  />
                  <s-text-field
                    name="postNumber"
                    label="Post code"
                    defaultValue={partner?.postNumber ?? ""}
                  />
                </s-grid>

                <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                  <s-text-field
                    name="place"
                    label="Town or city"
                    defaultValue={partner?.place ?? ""}
                  />
                  <s-text-field
                    name="country"
                    label="Country"
                    defaultValue={partner?.country ?? ""}
                    details="As MetaKocka spells it."
                  />
                </s-grid>

                <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                  <s-email-field
                    name="email"
                    label="Email"
                    defaultValue={partner?.email ?? ""}
                  />
                  <s-text-field
                    name="phone"
                    label="Phone"
                    defaultValue={partner?.phone ?? ""}
                  />
                </s-grid>

                <s-checkbox
                  name="isBusiness"
                  label="This is a business"
                  details="Sets the partner as a taxable business entity in MetaKocka."
                  {...(partner?.isBusiness ? { checked: true } : {})}
                />

                <s-box maxInlineSize="320px">
                  <s-text-field
                    name="taxNumber"
                    label="Tax number"
                    defaultValue={partner?.taxNumber ?? ""}
                    details="Optional. Used to match the existing partner in MetaKocka."
                  />
                </s-box>

                <s-stack direction="inline" gap="base">
                  <s-button
                    type="submit"
                    variant="primary"
                    {...(busy ? { disabled: true } : {})}
                  >
                    Save
                  </s-button>
                </s-stack>
              </s-stack>
            </Form>

            {partner ? (
              <Form method="post">
                <input type="hidden" name="intent" value="clear" />
                <s-button
                  type="submit"
                  variant="tertiary"
                  {...(busy ? { disabled: true } : {})}
                >
                  Turn off and use each order&apos;s customer
                </s-button>
              </Form>
            ) : null}
          </s-stack>
        </s-section>

        <Form method="post">
          <input type="hidden" name="intent" value="documents" />
          <input type="hidden" name="titleTemplate" value={title} />
          <s-stack direction="block" gap="large">
            <s-section heading="Wholesale pricing">
              <s-stack direction="block" gap="base">
                <s-paragraph>
                  {!pricelistCode
                    ? "Off. Lines carry the price the Shopify customer paid."
                    : partner
                      ? `Every sales order to ${partner.customer} is a wholesale order: each line at its net price on MetaKocka pricelist ${pricelistCode}${discountPercent ? ` less ${discountPercent}%` : ""}, with no VAT.`
                      : `Saved for pricelist ${pricelistCode}, and waiting for a MetaKocka customer above. It applies only to orders filed against that customer.`}
                </s-paragraph>
                <s-text color="subdued">
                  For a reseller&apos;s store. The sales order then has no
                  delivery address, no shipping, no Shopify discount and no
                  payment, and the Shopify customer goes in its notes. An order
                  with customer details entered by hand is sent as usual.
                </s-text>

                <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                  <s-text-field
                    name="pricelistCode"
                    label="MetaKocka pricelist code"
                    defaultValue={pricelistCode ?? ""}
                    details="The code, such as 4. Leave it empty to turn wholesale pricing off."
                  />
                  <s-text-field
                    name="discountPercent"
                    label="Line discount (%)"
                    defaultValue={discountPercent ?? ""}
                    details="Taken off every line's pricelist price, such as 20. Optional."
                  />
                </s-grid>
              </s-stack>
            </s-section>

            <s-section heading="Sales order title">
              <s-stack direction="block" gap="base">
                <PatternEditor
                  label="Title pattern"
                  value={title}
                  onChange={setTitle}
                  registry={ORDER_REFERENCE_REGISTRY}
                  rows={titleRows}
                  details="Shown as the title of every new sales order in MetaKocka. Leave it empty to send none."
                  {...(titlePreview && sample
                    ? {
                        preview: `Order ${sample.name} would be titled ${titlePreview}.`,
                      }
                    : {})}
                  {...(badTitleFields.length > 0
                    ? {
                        error: `${badTitleFields.map((field) => `{${field}}`).join(", ")} ${badTitleFields.length === 1 ? "is not a field" : "are not fields"} this app can fill in.`,
                      }
                    : {})}
                />
              </s-stack>
            </s-section>

            <s-stack direction="inline" gap="base">
              <s-button
                type="submit"
                variant="primary"
                {...(busy || badTitleFields.length > 0
                  ? { disabled: true }
                  : {})}
              >
                Save pricing and title
              </s-button>
            </s-stack>
          </s-stack>
        </Form>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
