import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { prisma } from "~/adapters/db/client.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { getReadiness } from "~/adapters/db/repositories/readiness.server";
import { getSupplyDefaults } from "~/adapters/db/repositories/supply-setting.server";
import {
  SALES_ORDER_DEFAULTS,
  getSalesOrderSettings,
  saveSalesOrderSettings,
  type SalesOrderSettings,
} from "~/adapters/db/repositories/sales-order-setting.server";
import { getCredential } from "~/adapters/db/repositories/metakocka-credential.server";
import { MetakockaClient } from "~/adapters/metakocka/client";
import { findProductByCode } from "~/adapters/metakocka/stock";
import { authenticate } from "~/adapters/shopify/shopify.server";
import {
  DEFAULT_CUSTOMER_ORDER_TEMPLATE,
  ORDER_REFERENCE_PLACEHOLDERS,
  orderReferenceFor,
  unknownPlaceholders,
} from "~/domain/orders/reference";
import { componentOf } from "~/domain/readiness";
import { AdvancedSection } from "~/web/components/advanced-section";
import { principalFromSession } from "~/web/lib/principal.server";

/**
 * How an order becomes a MetaKocka sales order, and what happens to it after.
 *
 * The decisions here are all real ones — each has a defensible answer in both
 * directions, depending on something only the merchant knows: whether they
 * invoice from these documents, whether their Shopify locations correspond to
 * how they actually warehouse things, whether their MetaKocka company will take
 * more than one payment on a sales order.
 *
 * **Real does not mean everyday.** This page used to present all nine as one
 * flat list of equal-looking cards, so a merchant who wanted to name their
 * shipping article read five questions about document retirement and payment
 * allocation first. The split is by how often the answer is not the default:
 * General is what a shop changes when it is set up, Advanced is what a shop
 * changes when something about it is unusual. Nothing was removed, and every
 * advanced control still says what it currently is without being opened.
 *
 * What is deliberately *not* here is anything that could be derived, or that
 * another page already owns. The warehouse mapping and the default profit
 * centre live with the locations, the payment types with the payment methods;
 * this page states what they currently are and links to them.
 */
const HELP_MODAL_ID = "about-order-sync";
const REFERENCE_MODAL_ID = "about-customer-order";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  /*
   * A real order for the reference preview.
   *
   * The UI conventions are explicit that sample data is the merchant's own and
   * that raw syntax never reaches them outside the field they are editing. So
   * the preview resolves against an order they can recognise, and a shop with
   * no orders yet gets nothing rather than a fabricated one.
   */
  const recent = await prisma.order.findFirst({
    where: { shop: { domain: session.shop }, shopifyDeletedAt: null },
    orderBy: { receivedAt: "desc" },
    select: {
      shopifyOrderId: true,
      shopifyOrderNumber: true,
      customerOrderRef: true,
    },
  });

  const [settings, readiness, supplyDefaults] = await Promise.all([
    getSalesOrderSettings(principal),
    getReadiness(principal),
    getSupplyDefaults(principal),
  ]);

  return {
    settings,
    sample: recent
      ? {
          id: recent.shopifyOrderId,
          number: recent.shopifyOrderNumber,
          name: `#${recent.shopifyOrderNumber}`,
          currentRef: recent.customerOrderRef,
        }
      : null,
    fields: ORDER_REFERENCE_PLACEHOLDERS.map((placeholder) => ({
      token: `{{${placeholder.token}}}`,
      label: placeholder.label,
    })),
    defaultPattern: DEFAULT_CUSTOMER_ORDER_TEMPLATE,
    /*
     * What this page states rather than owns. The counts and the profit centre
     * come from the pages that do own them, so a summary here can never say
     * something different from the screen that would change it.
     */
    status: {
      activated: readiness.activated,
      orders: componentOf(readiness, "orders").status,
      paymentsSummary: componentOf(readiness, "payments").summary,
      paymentsNeedsAttention:
        componentOf(readiness, "payments").status === "needs_attention",
      defaultProfitCenter: supplyDefaults.defaultProfitCenter,
    },
    /*
     * What a new shop gets, so "Restore recommended settings" can be a change
     * the merchant sees and saves rather than a hidden write.
     *
     * Only the behaviour settings. The shipping article and the discount
     * representation have no recommended value -- there is no safe default for
     * which article an accountant expects postage on -- and restoring them
     * would silently delete an answer only the merchant could give.
     */
    recommended: {
      updateOnChange: SALES_ORDER_DEFAULTS.updateOnChange,
      updateAfterPaid: SALES_ORDER_DEFAULTS.updateAfterPaid,
      allocationMode: SALES_ORDER_DEFAULTS.allocationMode,
      obsoleteDocumentPolicy: SALES_ORDER_DEFAULTS.obsoleteDocumentPolicy,
      syncPayments: SALES_ORDER_DEFAULTS.syncPayments,
      paymentAllocation: SALES_ORDER_DEFAULTS.paymentAllocation,
      paymentEntryMode: SALES_ORDER_DEFAULTS.paymentEntryMode,
    },
  };
};

/** The form's own vocabulary, narrowed before anything is stored. */
function readMode(
  raw: FormDataEntryValue | null,
): SalesOrderSettings["allocationMode"] {
  return raw === "stock_rules" ? "stock_rules" : "shopify_locations";
}

function readObsolete(
  raw: FormDataEntryValue | null,
): SalesOrderSettings["obsoleteDocumentPolicy"] {
  if (raw === "report") return "report";
  if (raw === "delete_unpaid") return "delete_unpaid";
  return "empty";
}

function readAllocation(
  raw: FormDataEntryValue | null,
): SalesOrderSettings["paymentAllocation"] {
  return raw === "primary" ? "primary" : "proportional";
}

function readEntryMode(
  raw: FormDataEntryValue | null,
): SalesOrderSettings["paymentEntryMode"] {
  return raw === "aggregate" ? "aggregate" : "per_transaction";
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const formData = await request.formData();
  const updateOnChange = formData.get("updateOnChange") === "on";
  const updateAfterPaid = formData.get("updateAfterPaid") === "on";
  const pattern = String(formData.get("customerOrderTemplate") ?? "").trim();

  const unknown = unknownPlaceholders(pattern);
  if (unknown.length > 0) {
    return {
      ok: false,
      message: `Nothing was saved: ${unknown
        .map((field) => `{{${field}}}`)
        .join(
          ", ",
        )} ${unknown.length === 1 ? "is not a field" : "are not fields"} this app can fill in. Use one of the fields listed under the box.`,
    };
  }

  const shippingProductCode =
    String(formData.get("shippingProductCode") ?? "").trim() || null;

  /*
   * A shipping article is checked against MetaKocka before it is saved.
   *
   * This is the one place a merchant hands the app a MetaKocka code by hand,
   * and a code that does not exist there is refused on the next order as a
   * rejected sales order — a puzzle, hours later, about an order that looked
   * fine. Checking here turns it into a sentence under the field. It is also
   * one of the few merchant-initiated actions allowed to wait on MetaKocka
   * (§2.5 forbids it on *page loads*, not on an explicit save).
   */
  if (shippingProductCode) {
    const credential = await getCredential(principal);
    if (!credential) {
      return {
        ok: false,
        message:
          "Nothing was saved: MetaKocka is not connected, so the shipping product could not be checked. Add the credentials on the Connection page first.",
      };
    }

    try {
      const found = await findProductByCode(
        new MetakockaClient({
          companyId: credential.companyId,
          secretKey: credential.secretKey,
        }),
        shippingProductCode,
      );
      if (!found) {
        return {
          ok: false,
          message: `Nothing was saved: MetaKocka has no product with the code "${shippingProductCode}". Create the article there first — this app never creates one from an order line.`,
        };
      }
    } catch (error) {
      return {
        ok: false,
        message: `Nothing was saved: MetaKocka could not be reached to check the shipping product. ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const settings: SalesOrderSettings = {
    updateOnChange,
    // Meaningless on its own, and storing it as true while updates are off
    // would turn itself on the moment they were switched back.
    updateAfterPaid: updateOnChange && updateAfterPaid,
    // Empty means the default; storing the default string would freeze it if
    // the default ever changed.
    customerOrderTemplate:
      pattern === "" || pattern === DEFAULT_CUSTOMER_ORDER_TEMPLATE
        ? null
        : pattern,
    allocationMode: readMode(formData.get("allocationMode")),
    obsoleteDocumentPolicy: readObsolete(
      formData.get("obsoleteDocumentPolicy"),
    ),
    syncPayments: formData.get("syncPayments") === "on",
    paymentAllocation: readAllocation(formData.get("paymentAllocation")),
    paymentEntryMode: readEntryMode(formData.get("paymentEntryMode")),
    shippingProductCode,
    discountRepresentation:
      formData.get("discountRepresentation") === "document_discount_value"
        ? "document_discount_value"
        : "none",
  };

  await saveSalesOrderSettings(principal, settings);

  await appendEvent(principal, {
    entityType: "sales_order_setting",
    event: "sales_order.settings_saved",
    detail: { ...settings },
  });

  return { ok: true, message: "Saved order sync settings." };
};

export default function OrderSyncSettings() {
  const { settings, sample, fields, defaultPattern, status, recommended } =
    useLoaderData<typeof loader>();
  const saver = useFetcher<typeof action>();
  const result = saver.data;
  const busy = saver.state !== "idle";

  const [form, setForm] = useState({
    ...settings,
    customerOrderTemplate: settings.customerOrderTemplate ?? "",
    shippingProductCode: settings.shippingProductCode ?? "",
  });

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const dirty =
    form.updateOnChange !== settings.updateOnChange ||
    form.updateAfterPaid !== settings.updateAfterPaid ||
    form.customerOrderTemplate !== (settings.customerOrderTemplate ?? "") ||
    form.allocationMode !== settings.allocationMode ||
    form.obsoleteDocumentPolicy !== settings.obsoleteDocumentPolicy ||
    form.syncPayments !== settings.syncPayments ||
    form.paymentAllocation !== settings.paymentAllocation ||
    form.paymentEntryMode !== settings.paymentEntryMode ||
    form.shippingProductCode !== (settings.shippingProductCode ?? "") ||
    form.discountRepresentation !== settings.discountRepresentation;

  const badFields = unknownPlaceholders(form.customerOrderTemplate);

  // Open already when this shop has a pattern of its own, closed when it is on
  // the default and the sentence says everything.
  const [customisingReference, setCustomisingReference] = useState(
    settings.customerOrderTemplate !== null,
  );

  /*
   * The advanced card, summarised without being opened, and put back without
   * being saved.
   *
   * `restoreRecommended` only changes the form, so the contextual save bar
   * appears and the merchant confirms it like any other edit (section 2.6). A
   * button that wrote straight through would be a bespoke save inside a card.
   */
  const atRecommended = (
    Object.keys(recommended) as (keyof typeof recommended)[]
  ).every((key) => form[key] === recommended[key]);

  const restoreRecommended = () =>
    setForm((current) => ({ ...current, ...recommended }));

  const advancedSummary = [
    `Warehouse from ${form.allocationMode === "shopify_locations" ? "Shopify" : "stock levels"}`,
    form.updateOnChange
      ? "changed orders update the sales order"
      : "changed orders are reported",
    form.syncPayments ? "payments recorded" : "payments not recorded",
  ].join(", ");

  /*
   * The resolved reference, for one of the merchant's own orders.
   *
   * Rendered with exactly the function the intake path uses, so what is shown
   * is what would be sent — including the fallback, which is the part most
   * worth seeing: a pattern that depends on a customer email quietly falls back
   * for guest checkouts, and that should be visible here rather than
   * discovered in the ERP.
   */
  const preview = sample
    ? orderReferenceFor(form.customerOrderTemplate.trim() || defaultPattern, {
        name: sample.name,
        number: sample.number,
        id: sample.id,
        customerEmail: null,
      })
    : null;

  useEffect(() => {
    if (typeof shopify === "undefined") return;
    if (dirty) void shopify.saveBar.show("order-sync-save-bar");
    else void shopify.saveBar.hide("order-sync-save-bar");
  }, [dirty]);

  useEffect(() => {
    if (!result) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [result]);

  const save = () =>
    saver.submit(
      {
        updateOnChange: form.updateOnChange ? "on" : "",
        updateAfterPaid: form.updateAfterPaid ? "on" : "",
        customerOrderTemplate: form.customerOrderTemplate,
        allocationMode: form.allocationMode,
        obsoleteDocumentPolicy: form.obsoleteDocumentPolicy,
        syncPayments: form.syncPayments ? "on" : "",
        paymentAllocation: form.paymentAllocation,
        paymentEntryMode: form.paymentEntryMode,
        shippingProductCode: form.shippingProductCode,
        discountRepresentation: form.discountRepresentation,
      },
      { method: "post" },
    );

  const discard = () =>
    setForm({
      ...settings,
      customerOrderTemplate: settings.customerOrderTemplate ?? "",
      shippingProductCode: settings.shippingProductCode ?? "",
    });

  return (
    <s-page heading="Order settings">
      <s-link slot="breadcrumb-actions" href="/app/orders">
        Orders
      </s-link>

      <s-button
        slot="secondary-actions"
        icon="question-circle"
        command="--show"
        commandFor={HELP_MODAL_ID}
      >
        Help
      </s-button>

      <s-modal id={HELP_MODAL_ID} heading="About order sync">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Every time something happens to an order — it is placed, paid,
            edited, moved to another location, refunded — this app reads the
            order back from Shopify, works out what MetaKocka should hold for
            it, and changes only the difference. It never creates a second sales
            order for an order that already has one.
          </s-paragraph>
          <s-paragraph>
            MetaKocka has no way to change part of a document. An update
            replaces the whole sales order with what is sent, so the document is
            rebuilt from the order as it now stands and read back to check every
            line survived.
          </s-paragraph>
          <s-paragraph>
            After each pass the app checks its own work: the quantities across
            every MetaKocka document for the order must add up to exactly what
            Shopify says the customer is buying. When they do not, the order is
            reported as needing attention with the difference stated per SKU —
            and nothing extra is written, because another document would make
            the difference bigger.
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

      <ui-save-bar id="order-sync-save-bar">
        <button variant="primary" onClick={save} disabled={busy}>
          Save
        </button>
        <button onClick={discard} disabled={busy}>
          Discard
        </button>
      </ui-save-bar>

      <s-stack direction="block" gap="large">
        {result && !result.ok ? (
          <s-banner tone="critical" heading="That could not be saved">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        {/* ------------------------------------------------------------- */}
        <s-section heading="Order synchronization">
          <s-stack direction="block" gap="base">
            {/*
             * Stated, not switched. There is no on/off control for order sync
             * because there is no such setting: orders are synchronized once
             * setup is finished and the configuration holds, which is what this
             * line reports. A toggle that only ever reflected other settings
             * would be a lie with a checkbox next to it.
             */}
            <s-grid
              gridTemplateColumns="1fr auto"
              gap="base"
              alignItems="center"
            >
              <s-stack direction="block" gap="small-500">
                <s-text type="strong">Automatic order synchronization</s-text>
                <s-text color="subdued">
                  Shopify orders are created as MetaKocka sales orders. An order
                  fulfilled from more than one warehouse gets one sales order
                  per warehouse, and the same sales order is updated afterwards
                  rather than duplicated.
                </s-text>
              </s-stack>
              {status.activated && status.orders === "ready" ? (
                <s-text color="subdued">Active</s-text>
              ) : (
                <s-badge tone="critical">Not running</s-badge>
              )}
            </s-grid>

            {!status.activated ? (
              <s-text color="subdued" tone="critical">
                Setup has not been finished, so nothing is sent to MetaKocka
                yet.
              </s-text>
            ) : status.orders !== "ready" ? (
              <s-text color="subdued" tone="critical">
                Orders cannot be filed until the MetaKocka connection works and
                at least one Shopify location points at a warehouse.
              </s-text>
            ) : null}

            <s-divider />

            {/*
             * Two settings this page states and another page owns. A second
             * editable copy here is how two screens end up disagreeing about one
             * value (docs/ui-conventions.md: a card whose only content is a
             * pointer elsewhere becomes a line, not a card).
             */}
            <s-grid
              gridTemplateColumns="1fr auto"
              gap="base"
              alignItems="center"
            >
              <s-stack direction="block" gap="small-500">
                <s-text type="strong">Payment methods</s-text>
                <s-text
                  color="subdued"
                  tone={status.paymentsNeedsAttention ? "critical" : "auto"}
                >
                  {status.paymentsSummary}
                </s-text>
              </s-stack>
              <s-button
                variant="secondary"
                href="/app/orders/settings/payments"
              >
                Manage
              </s-button>
            </s-grid>

            <s-grid
              gridTemplateColumns="1fr auto"
              gap="base"
              alignItems="center"
            >
              <s-stack direction="block" gap="small-500">
                <s-text type="strong">Default profit centre</s-text>
                <s-text color="subdued">
                  {status.defaultProfitCenter
                    ? `${status.defaultProfitCenter}, on every sales order that has not overridden it.`
                    : "None, so MetaKocka applies the company setting."}
                </s-text>
              </s-stack>
              <s-button variant="secondary" href="/app/locations">
                Manage
              </s-button>
            </s-grid>
          </s-stack>
        </s-section>

        <s-section heading="Order reference">
          <s-stack direction="block" gap="base">
            {/*
             * The pattern is a real setting and an unusual one to change, so it
             * is behind Customize rather than being the first thing on the card
             * (docs/ui-conventions.md: raw syntax never reaches a merchant
             * outside the field they are editing it in). A shop on the default
             * reads a sentence; a shop that has changed it opens on the field,
             * because hiding a value somebody set is its own kind of confusing.
             */}
            {customisingReference ? (
              <>
                <s-text-field
                  name="customerOrderTemplate"
                  label="Reference pattern"
                  value={form.customerOrderTemplate}
                  placeholder={defaultPattern}
                  error={
                    badFields.length > 0
                      ? `${badFields.map((field) => `{{${field}}}`).join(", ")} ${badFields.length === 1 ? "is not a field" : "are not fields"} this app can fill in.`
                      : undefined
                  }
                  onChange={(event) =>
                    set("customerOrderTemplate", event.currentTarget.value)
                  }
                />

                <s-text color="subdued">
                  Fields you can use:{" "}
                  {fields.map((field) => field.token).join(", ")}. Leave the box
                  empty for the default.
                </s-text>
              </>
            ) : (
              <s-stack direction="block" gap="small-400">
                <s-text>Shopify order number</s-text>
                <s-stack direction="inline">
                  <s-button
                    type="button"
                    variant="tertiary"
                    onClick={() => setCustomisingReference(true)}
                  >
                    Customize
                  </s-button>
                </s-stack>
              </s-stack>
            )}

            {preview && sample ? (
              <s-stack direction="block" gap="small-400">
                <s-text>
                  Order {sample.name} would be filed in MetaKocka as{" "}
                  <s-text type="strong">{preview.reference}</s-text>.
                </s-text>
                {preview.usedFallback ? (
                  <s-text color="subdued">
                    That pattern produced nothing for this order, so the default
                    was used. Orders with no customer email fall back the same
                    way.
                  </s-text>
                ) : null}
                <s-text color="subdued">
                  Orders already sent keep the reference they were sent with —
                  including {sample.name}, which carries {sample.currentRef}.
                  Changing this only affects orders that arrive from now on.
                </s-text>
              </s-stack>
            ) : (
              <s-text color="subdued">
                A preview will appear here once this app has seen an order.
              </s-text>
            )}

            <s-button
              icon="question-circle"
              command="--show"
              commandFor={REFERENCE_MODAL_ID}
            >
              What this is used for
            </s-button>
          </s-stack>
        </s-section>

        <s-modal id={REFERENCE_MODAL_ID} heading="About Customer's order">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              This is what MetaKocka shows as <em>Customer&rsquo;s order</em> on
              the sales order. It is also how the sales orders of one Shopify
              order are linked to each other when the order ships from more than
              one warehouse, and how this app finds a document again if a write
              times out.
            </s-paragraph>
            <s-paragraph>
              It is a reference, not an identity. This app matches orders by
              their Shopify id, so changing the pattern is safe and never
              rewrites what MetaKocka already holds.
            </s-paragraph>
          </s-stack>
          <s-button
            slot="primary-action"
            variant="primary"
            command="--hide"
            commandFor={REFERENCE_MODAL_ID}
          >
            Close
          </s-button>
        </s-modal>

        <s-section heading="Shipping and discounts">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              MetaKocka sales orders carry products. Shipping and discounts are
              not products, so each needs somewhere to go before the sales order
              can add up to what the customer was charged.
            </s-paragraph>

            <s-text-field
              name="shippingProductCode"
              label="Shipping product code"
              value={form.shippingProductCode}
              placeholder="e.g. SHIPPING"
              details="The MetaKocka article a shipping charge is written against. It is checked against MetaKocka when you save; this app never creates one."
              onChange={(event) =>
                set("shippingProductCode", event.currentTarget.value)
              }
            />

            <s-choice-list
              name="discountRepresentation"
              label="Discounts"
              values={[form.discountRepresentation]}
              onChange={(event) =>
                set(
                  "discountRepresentation",
                  event.currentTarget.values[0] === "document_discount_value"
                    ? "document_discount_value"
                    : "none",
                )
              }
            >
              <s-choice value="document_discount_value">
                Write the discount on the sales order
                <s-text slot="details">
                  Uses MetaKocka&rsquo;s own discount field, as an amount. It
                  comes off the document total, so the sales order matches what
                  the customer paid.
                </s-text>
              </s-choice>
              <s-choice value="none">
                Do not write discounts
                <s-text slot="details">
                  The sales order shows the goods at full price. An order with a
                  discount is reported as needing attention, because MetaKocka
                  will not match what the customer was charged.
                </s-text>
              </s-choice>
            </s-choice-list>

            {form.shippingProductCode.trim() === "" ||
            form.discountRepresentation === "none" ? (
              <s-banner
                tone="warning"
                heading="Orders will be reported as not fully reconciled"
              >
                <s-paragraph>
                  {form.shippingProductCode.trim() === "" &&
                  form.discountRepresentation === "none"
                    ? "Shipping and discounts have nowhere to go."
                    : form.shippingProductCode.trim() === ""
                      ? "Shipping has nowhere to go."
                      : "Discounts have nowhere to go."}{" "}
                  An order carrying one is still sent — the goods are right —
                  but MetaKocka will be short by that amount, and the order is
                  reported rather than counted as reconciled. Nothing is
                  guessed.
                </s-paragraph>
              </s-banner>
            ) : null}
          </s-stack>
        </s-section>

        {/* ------------------------------------------------------------- */}
        {/*
         * Everything below is right for almost every shop and wrong for a few.
         * Closed, the card still answers itself: the summary says what the
         * settings inside currently are, so opening it is for changing rather
         * than for checking.
         */}
        <AdvancedSection summary={advancedSummary}>
          <s-stack direction="block" gap="large-100">
            <s-stack direction="block" gap="base">
              <s-heading>Where each line is fulfilled from</s-heading>
              <s-stack direction="block" gap="base">
                <s-choice-list
                  name="allocationMode"
                  label="Which system decides the warehouse"
                  values={[form.allocationMode]}
                  onChange={(event) =>
                    set(
                      "allocationMode",
                      (event.currentTarget.values[0] ?? "shopify_locations") ===
                        "stock_rules"
                        ? "stock_rules"
                        : "shopify_locations",
                    )
                  }
                >
                  <s-choice value="shopify_locations">
                    Shopify
                    <s-text slot="details">
                      Follow the location Shopify has assigned each item to.
                      Moving an item to another location in Shopify moves it to
                      the mapped MetaKocka warehouse, and the total across the
                      sales orders stays exactly what the customer ordered.
                      Anything Shopify has not assigned — a digital item, a
                      fulfilment service this app cannot see — falls back to
                      stock levels.
                    </s-text>
                  </s-choice>
                  <s-choice value="stock_rules">
                    Stock levels
                    <s-text slot="details">
                      Ignore Shopify&rsquo;s assignment and choose from the
                      stock this app has read: own warehouses first, then
                      partners. For stores whose Shopify locations do not
                      correspond to how goods are actually warehoused. Stores
                      that were already running before Shopify locations were
                      supported stay on this until they choose otherwise.
                    </s-text>
                  </s-choice>
                </s-choice-list>

                {/*
                 * The overwrite-risk pattern from docs/ui-conventions.md: one
                 * standing line under the control, plus a banner that renders only
                 * in the unsaved-changes state, naming what will actually change.
                 *
                 * Changing this authority restructures documents — that is the
                 * whole point of it — so the merchant sees the consequence before
                 * saving rather than discovering it on their next order.
                 */}
                {form.allocationMode !== settings.allocationMode ? (
                  <s-banner
                    tone="warning"
                    heading="This changes which warehouse orders are filed against"
                  >
                    <s-paragraph>
                      {form.allocationMode === "shopify_locations"
                        ? "From the next time each order is checked, its MetaKocka sales orders will be rebuilt to match the locations Shopify has assigned. Orders currently filed against a warehouse this app chose from stock levels will move, and a sales order left with nothing on it is reported for you to cancel or credit."
                        : "From the next time each order is checked, warehouses will be chosen from stock levels again and Shopify's own location assignment will be ignored. Orders currently following Shopify may move to a different MetaKocka warehouse."}
                    </s-paragraph>
                    <s-paragraph>
                      Orders already sent are only rebuilt when something
                      changes them or you check them by hand. Nothing is re-sent
                      in bulk.
                    </s-paragraph>
                  </s-banner>
                ) : null}

                <s-text color="subdued">
                  Which MetaKocka warehouse a Shopify location means is set on
                  the <s-link href="/app/locations">Locations</s-link> page. A
                  location with no warehouse mapped is reported rather than
                  guessed at.
                </s-text>
              </s-stack>
            </s-stack>

            <s-stack direction="block" gap="base">
              <s-heading>When a Shopify order changes</s-heading>
              <s-stack direction="block" gap="base">
                <s-stack direction="block" gap="small-400">
                  <s-checkbox
                    name="updateOnChange"
                    value="on"
                    label="Update the MetaKocka sales order"
                    checked={form.updateOnChange}
                    onChange={(event) =>
                      set("updateOnChange", event.currentTarget.checked)
                    }
                  />
                  <s-text color="subdued">
                    A quantity changed, a line added or removed, a price
                    corrected: the sales order in MetaKocka is rebuilt to match
                    and read back to confirm it. With this off, the order is
                    flagged as needing attention and the document is left
                    exactly as it was.
                  </s-text>
                </s-stack>

                {form.updateOnChange ? (
                  <s-stack direction="block" gap="small-400">
                    <s-checkbox
                      name="updateAfterPaid"
                      value="on"
                      label="Update it even after the payment has been recorded"
                      checked={form.updateAfterPaid}
                      onChange={(event) =>
                        set("updateAfterPaid", event.currentTarget.checked)
                      }
                    />
                    <s-text color="subdued">
                      Leave this off if you issue invoices from these sales
                      orders. A paid document is the one most likely to have
                      been invoiced, and rewriting an invoiced document changes
                      an accounting record. This covers changes to the order
                      itself — a payment arriving later is always recorded.
                    </s-text>
                  </s-stack>
                ) : null}

                <s-choice-list
                  name="obsoleteDocumentPolicy"
                  label="A sales order the Shopify order no longer uses"
                  values={[form.obsoleteDocumentPolicy]}
                  onChange={(event) =>
                    set(
                      "obsoleteDocumentPolicy",
                      readObsoleteClient(event.currentTarget.values[0]),
                    )
                  }
                >
                  <s-choice value="empty">
                    Remove its lines and report it
                    <s-text slot="details">
                      When every item moves to another warehouse, the sales
                      order left behind has its lines removed so it stops
                      holding goods this order no longer takes from there, and
                      the document itself is kept — it may already be invoiced.
                      You are told either way.
                    </s-text>
                  </s-choice>
                  <s-choice value="report">
                    Report it and change nothing
                    <s-text slot="details">
                      The sales order is left exactly as it is. The goods stay
                      on it in MetaKocka until you deal with it, so the order
                      will show as holding more than the customer bought.
                    </s-text>
                  </s-choice>
                  <s-choice value="delete_unpaid">
                    Delete it when nothing has been paid against it
                    <s-text slot="details">
                      Only ever an unpaid sales order, and only one this order
                      no longer takes anything from. One that carries a payment
                      has its lines removed instead. Nothing else in this app
                      deletes a MetaKocka document, ever.
                    </s-text>
                  </s-choice>
                </s-choice-list>
              </s-stack>
            </s-stack>

            <s-stack direction="block" gap="base">
              <s-heading>How payments are recorded</s-heading>
              <s-stack direction="block" gap="base">
                <s-stack direction="block" gap="small-400">
                  <s-checkbox
                    name="syncPayments"
                    value="on"
                    label="Record payments on the MetaKocka sales order"
                    checked={form.syncPayments}
                    onChange={(event) =>
                      set("syncPayments", event.currentTarget.checked)
                    }
                  />
                  <s-text color="subdued">
                    Every successful payment Shopify records is sent as its own
                    entry, so an order paid in two parts shows as two payments
                    for the right amounts. With this off, what has been paid is
                    still shown on the order page and nothing is written to
                    MetaKocka.
                  </s-text>
                </s-stack>

                {form.syncPayments ? (
                  <>
                    <s-choice-list
                      name="paymentAllocation"
                      label="An order that ships from more than one warehouse"
                      values={[form.paymentAllocation]}
                      onChange={(event) =>
                        set(
                          "paymentAllocation",
                          event.currentTarget.values[0] === "primary"
                            ? "primary"
                            : "proportional",
                        )
                      }
                    >
                      <s-choice value="proportional">
                        Split each payment across the sales orders by value
                        <s-text slot="details">
                          A €300 order split into a €100 and a €200 sales order
                          records €100 and €200. The parts always add back up to
                          exactly what was paid.
                        </s-text>
                      </s-choice>
                      <s-choice value="primary">
                        Put it all on the main sales order
                        <s-text slot="details">
                          The one carrying the shipping. For stores that treat
                          the others as picking documents and settle the order
                          in one place.
                        </s-text>
                      </s-choice>
                    </s-choice-list>

                    <s-choice-list
                      name="paymentEntryMode"
                      label="An order paid more than once"
                      values={[form.paymentEntryMode]}
                      onChange={(event) =>
                        set(
                          "paymentEntryMode",
                          event.currentTarget.values[0] === "aggregate"
                            ? "aggregate"
                            : "per_transaction",
                        )
                      }
                    >
                      <s-choice value="per_transaction">
                        One payment per Shopify payment
                        <s-text slot="details">
                          A deposit and a balance appear as two payments on
                          their own dates.
                        </s-text>
                      </s-choice>
                      <s-choice value="aggregate">
                        One payment per payment type
                        <s-text slot="details">
                          Amounts are added together and dated from the last
                          one. Use this only if your MetaKocka company refuses a
                          sales order with more than one payment on it.
                        </s-text>
                      </s-choice>
                    </s-choice-list>

                    <s-text color="subdued">
                      Which MetaKocka payment type a Shopify gateway means is
                      set on the{" "}
                      <s-link href="/app/orders/settings/payments">
                        Payment types
                      </s-link>{" "}
                      page. A gateway with no type and no fallback is reported
                      rather than guessed at.
                    </s-text>
                  </>
                ) : null}
              </s-stack>
            </s-stack>

            <s-stack direction="block" gap="small-400">
              <s-divider />
              <s-stack direction="inline">
                <s-button
                  type="button"
                  variant="secondary"
                  onClick={restoreRecommended}
                  {...(atRecommended ? { disabled: true } : {})}
                >
                  Restore recommended settings
                </s-button>
              </s-stack>
              <s-text color="subdued">
                Puts the settings in this card back to what they are for a new
                shop. It changes nothing until you save, and it never touches
                the shipping product or the discount setting, which are yours to
                choose.
              </s-text>
            </s-stack>
          </s-stack>
        </AdvancedSection>

        {/* ------------------------------------------------------------- */}
        <s-section heading="What is never done automatically">
          <s-unordered-list>
            <s-list-item>
              A second sales order is never created for an order that already
              has one. When items move between warehouses the existing sales
              orders are changed, never duplicated.
            </s-list-item>
            <s-list-item>
              A MetaKocka document is never deleted, whatever happens in Shopify
              — including a cancelled or deleted order. The one exception is the
              setting above, which you have to turn on, and which only ever
              removes an unpaid sales order this order no longer uses.
            </s-list-item>
            <s-list-item>
              Refunds and credit notes are never sent. A refund is recorded in
              this app so what the customer has paid stays right, and reported
              for you to credit in MetaKocka — a payment already recorded is
              never shrunk to represent one.
            </s-list-item>
            <s-list-item>
              A payment type is never guessed, and a card authorisation is never
              treated as money received.
            </s-list-item>
            <s-list-item>
              A shipping or discount article is never invented in MetaKocka. If
              one is not configured, the order is reported rather than sent with
              money missing and no mention of it.
            </s-list-item>
          </s-unordered-list>
        </s-section>
      </s-stack>
    </s-page>
  );
}

/** The browser-side narrowing, matching `readObsolete` on the server. */
function readObsoleteClient(
  raw: string | undefined,
): SalesOrderSettings["obsoleteDocumentPolicy"] {
  if (raw === "report") return "report";
  if (raw === "delete_unpaid") return "delete_unpaid";
  return "empty";
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
