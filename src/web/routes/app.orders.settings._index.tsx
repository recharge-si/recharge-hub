import { boundary } from "@shopify/shopify-app-react-router/server";
import { useCallback, useEffect, useMemo, useState } from "react";
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
  orderReferenceFor,
  unknownPlaceholders,
  type OrderReferenceContext,
} from "~/domain/orders/reference";
import { componentOf } from "~/domain/readiness";
import { AdvancedSection } from "~/web/components/advanced-section";
import { LearnMore } from "~/web/components/learn-more";
import { SettingRow } from "~/web/components/setting-row";
import { PatternEditor } from "~/web/components/pattern-editor";
import { PatternFieldsModal } from "~/web/components/pattern-fields-modal";
import { ReferencePatternsModal } from "~/web/components/reference-patterns-modal";
import {
  ORDER_REFERENCE_REGISTRY,
  orderReferenceRows,
} from "~/web/lib/order-reference-fields";
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
const REFERENCE_PATTERNS_MODAL_ID = "ready-reference-patterns";
const REFERENCE_FIELDS_MODAL_ID = "reference-fields";

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
function readSplit(
  raw: FormDataEntryValue | null,
): SalesOrderSettings["salesOrderSplit"] {
  return raw === "single" ? "single" : "per_warehouse";
}

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
        .map((field) => `{${field}}`)
        .join(
          ", ",
        )} ${unknown.length === 1 ? "is not a field" : "are not fields"} this app can fill in. Choose one from the list the pattern offers.`,
    };
  }

  const shippingProductCode =
    String(formData.get("shippingProductCode") ?? "").trim() || null;

  /** True when MetaKocka never confirmed the code either way. */
  let unconfirmedShippingCode = false;

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
      const lookup = await findProductByCode(
        new MetakockaClient({
          companyId: credential.companyId,
          secretKey: credential.secretKey,
        }),
        shippingProductCode,
      );

      if (lookup.status === "absent") {
        return {
          ok: false,
          message: `Nothing was saved: MetaKocka has no product with the code "${shippingProductCode}". Create the article there first — this app never creates one from an order line.`,
        };
      }

      /*
       * `unknown` means the catalogue could not be read to the end, not that
       * the article is missing, so the save goes through and says so. Refusing
       * on a check that did not finish is how a merchant whose article exists
       * ends up unable to save their settings at all.
       */
      unconfirmedShippingCode = lookup.status === "unknown";
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
    salesOrderSplit: readSplit(formData.get("salesOrderSplit")),
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

  return {
    ok: true,
    message: unconfirmedShippingCode
      ? `Saved. MetaKocka did not answer whether "${shippingProductCode}" is one of its products, so check the code exists — an order with shipping is refused if it does not.`
      : "Saved order sync settings.",
  };
};

export default function OrderSyncSettings() {
  const { settings, sample, defaultPattern, status, recommended } =
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
    form.salesOrderSplit !== settings.salesOrderSplit ||
    form.allocationMode !== settings.allocationMode ||
    form.obsoleteDocumentPolicy !== settings.obsoleteDocumentPolicy ||
    form.syncPayments !== settings.syncPayments ||
    form.paymentAllocation !== settings.paymentAllocation ||
    form.paymentEntryMode !== settings.paymentEntryMode ||
    form.shippingProductCode !== (settings.shippingProductCode ?? "") ||
    form.discountRepresentation !== settings.discountRepresentation;

  const badFields = unknownPlaceholders(form.customerOrderTemplate);

  /*
   * Whether order sync is running, and the one thing stopping it. Derived here
   * rather than inline, so the row and the line under it cannot disagree about
   * what "not running" means.
   */
  const running = status.activated && status.orders === "ready";
  const blocking = !status.activated
    ? "Setup has not been finished, so nothing is sent to MetaKocka yet."
    : status.orders !== "ready"
      ? // A warehouse mapping is not what stops an unsplit shop: its documents
        // carry no warehouse. What stops it is the connection.
        settings.salesOrderSplit === "single"
        ? "Orders cannot be filed until the MetaKocka connection works."
        : "Orders cannot be filed until the MetaKocka connection works and at least one Shopify location points at a warehouse."
      : null;

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

  /** True while this shop writes one sales order for a whole Shopify order. */
  const unsplit = form.salesOrderSplit === "single";

  const advancedSummary = [
    unsplit
      ? "Not split by warehouse"
      : `Warehouse from ${form.allocationMode === "shopify_locations" ? "Shopify" : "stock levels"}`,
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
  /*
   * The order every part of this card reads the pattern against: the preview
   * below it, the fields the editor offers, and what each ready pattern would
   * produce. One context, so the three cannot disagree.
   *
   * No customer email, because this app does not keep one. That field still
   * exists and still renders; it simply has nothing to show here, which the
   * picker states by showing no value rather than an empty one.
   */
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

  const referenceRows = useCallback(
    (query: string) => orderReferenceRows(query, sampleContext),
    [sampleContext],
  );

  const preview = sampleContext
    ? orderReferenceFor(
        form.customerOrderTemplate.trim() || defaultPattern,
        sampleContext,
      )
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
        salesOrderSplit: form.salesOrderSplit,
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


      {/*
       * The two ways in that do not involve typing, the same pair the product
       * name pattern offers: what the fields are, and four patterns already
       * written. Modals rather than disclosures because both are lists to read
       * or pick from rather than prose about the control.
       */}
      <PatternFieldsModal
        id={REFERENCE_FIELDS_MODAL_ID}
        heading="What you can put in a reference"
        resolvedAgainst={
          sample ? `order ${sample.name}` : "one of your own orders"
        }
        groups={referenceRows("")}
      />

      <ReferencePatternsModal
        id={REFERENCE_PATTERNS_MODAL_ID}
        current={form.customerOrderTemplate}
        defaultPattern={defaultPattern}
        sample={sampleContext}
        onChoose={(pattern) => set("customerOrderTemplate", pattern)}
      />

      <s-modal id={HELP_MODAL_ID} heading="About order sync">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Every time something happens to an order — it is placed, paid,
            edited, moved to another location, refunded — this app reads the
            order back from Shopify, works out what MetaKocka should hold for
            it, and changes only the difference. It never creates a second sales
            order for an order that already has one.{" "}
            {unsplit
              ? "This shop writes one sales order for the whole order, whatever it ships from, and updates that one afterwards rather than duplicating it."
              : "An order fulfilled from more than one warehouse gets one sales order per warehouse, and those are updated afterwards rather than duplicated."}
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

        {/* ---------------------------------------------------------------
         * What is running, and what the two pages that own the rest of it
         * currently answer.
         *
         * Rows rather than paragraphs, and the same row three times: the name,
         * what it says now, and the control that changes it, aligned down the
         * card. Read as a column of answers, a merchant can tell in one pass
         * whether anything here needs them.
         * --------------------------------------------------------------- */}
        <s-section heading="Order synchronization">
          <s-stack direction="block" gap="base">
            {/*
             * Stated, not switched. There is no on/off control for order sync
             * because there is no such setting: orders are synchronized once
             * setup is finished and the configuration holds, which is what this
             * line reports. A toggle that only ever reflected other settings
             * would be a lie with a checkbox next to it.
             */}
            <SettingRow
              label="Automatic order synchronization"
              summary={
                unsplit
                  ? "Shopify orders become MetaKocka sales orders, one for each order."
                  : "Shopify orders become MetaKocka sales orders, one per warehouse an order ships from."
              }
              action={
                running ? (
                  <s-text color="subdued">Active</s-text>
                ) : (
                  <s-badge tone="critical">Not running</s-badge>
                )
              }
            />

            {blocking ? (
              <s-text color="subdued" tone="critical">
                {blocking}
              </s-text>
            ) : null}

            <s-divider />

            {/*
             * Two settings this page states and another page owns. A second
             * editable copy here is how two screens end up disagreeing about
             * one value (docs/ui-conventions.md: a card whose only content is a
             * pointer elsewhere becomes a line, not a card).
             */}
            <SettingRow
              label="Payment methods"
              summary={status.paymentsSummary}
              tone={status.paymentsNeedsAttention ? "critical" : "auto"}
              action={
                <s-button
                  variant="secondary"
                  href="/app/orders/settings/payments"
                >
                  Manage
                </s-button>
              }
            />

            <s-divider />

            <SettingRow
              label="Default profit centre"
              summary={
                status.defaultProfitCenter
                  ? `${status.defaultProfitCenter}, on every sales order that has not overridden it.`
                  : "None, so MetaKocka applies the company setting."
              }
              action={
                <s-button variant="secondary" href="/app/locations">
                  Manage
                </s-button>
              }
            />
          </s-stack>
        </s-section>

        {/* ---------------------------------------------------------------
         * How many sales orders one Shopify order becomes.
         *
         * Not in the advanced card, and deliberately. Everything in there is
         * right for almost every shop and wrong for a few; this is a genuine
         * fork that depends on something only the merchant knows — whether
         * their MetaKocka company keeps stock per warehouse at all — and it
         * changes the shape of every document the app writes. A merchant who
         * came here to answer it should not have to open a disclosure first.
         * --------------------------------------------------------------- */}
        <s-section heading="Sales orders">
          <s-stack direction="block" gap="base">
            <s-choice-list
              name="salesOrderSplit"
              label="How many sales orders one Shopify order becomes"
              values={[form.salesOrderSplit]}
              onChange={(event) =>
                set(
                  "salesOrderSplit",
                  event.currentTarget.values[0] === "single"
                    ? "single"
                    : "per_warehouse",
                )
              }
            >
              <s-choice value="per_warehouse">
                One for each warehouse it ships from
                <s-text slot="details">
                  Each sales order is filed against its own MetaKocka warehouse,
                  and they are linked by the order reference.
                </s-text>
              </s-choice>
              <s-choice value="single">
                One for the whole order
                <s-text slot="details">
                  A single sales order carrying every line, with no warehouse on
                  it. MetaKocka files it against the company default.
                </s-text>
              </s-choice>
            </s-choice-list>

            {/*
             * The overwrite-risk pattern from docs/ui-conventions.md: a banner
             * only in the unsaved-changes state, naming what will actually
             * happen to documents MetaKocka already holds.
             */}
            {form.salesOrderSplit !== settings.salesOrderSplit ? (
              <s-banner
                tone="warning"
                heading="This changes the sales orders MetaKocka already holds"
              >
                <s-paragraph>
                  {form.salesOrderSplit === "single"
                    ? "From the next time each order is checked, its per-warehouse sales orders are replaced by one sales order for the whole order. The old ones are dealt with by your setting for a sales order the Shopify order no longer uses — their lines removed by default, and never deleted without you asking."
                    : "From the next time each order is checked, each order is split again across the warehouses it ships from. The single sales order it has now is dealt with by your setting for a sales order the Shopify order no longer uses, and new ones are written per warehouse."}
                </s-paragraph>
                <s-paragraph>
                  Orders already sent are only rebuilt when something changes
                  them or you check them by hand. Nothing is re-sent in bulk.
                </s-paragraph>
              </s-banner>
            ) : null}

            {unsplit ? (
              <s-text color="subdued">
                Warehouses are still mapped on the{" "}
                <s-link href="/app/locations">Locations</s-link> page, because
                that is what stock synchronization uses. They just do not appear
                on the sales order.
              </s-text>
            ) : null}

            <LearnMore label="What each one means in MetaKocka">
              <s-paragraph>
                <s-text type="strong">One for each warehouse.</s-text>{" "}
                MetaKocka&rsquo;s warehouse is a property of the whole document,
                so an order shipping from two warehouses can only be described
                as two sales orders. Each one says where its goods left from,
                which is what keeps stock in MetaKocka right, and the two carry
                the same customer&rsquo;s order reference so they can be found
                together.
              </s-paragraph>
              <s-paragraph>
                <s-text type="strong">One for the whole order.</s-text> One
                sales order per Shopify order, whatever it ships from, with no
                warehouse on it — so MetaKocka applies the company default. For
                shops that do not run their warehouses in MetaKocka, or that
                want the two systems to show one document each. The trade is
                real: MetaKocka no longer records which warehouse the goods left
                from, and this app stops choosing one.
              </s-paragraph>
              <s-paragraph>
                Everything else is the same either way. Changed orders are still
                rebuilt, payments still recorded, and the quantities still
                checked against what Shopify says the customer bought.
              </s-paragraph>
            </LearnMore>
          </s-stack>
        </s-section>

        {/* ---------------------------------------------------------------
         * Order references.
         *
         * The pattern is a real setting and an unusual one to change, so the
         * card opens on what it currently produces and the editor is one click
         * away (docs/ui-conventions.md: raw syntax never reaches a merchant
         * outside the field they are editing it in). A shop that has changed it
         * opens on the editor, because hiding a value somebody set is its own
         * kind of confusing.
         * --------------------------------------------------------------- */}
        <s-section heading="Order references">
          <s-stack direction="block" gap="base">
            <SettingRow
              label="Customer’s order"
              summary={
                preview && sample
                  ? `Order ${sample.name} would be filed in MetaKocka as ${preview.reference}.`
                  : "A preview will appear here once this app has seen an order."
              }
              action={
                customisingReference ? null : (
                  <s-button
                    type="button"
                    variant="secondary"
                    onClick={() => setCustomisingReference(true)}
                  >
                    Customize
                  </s-button>
                )
              }
            />

            {customisingReference ? (
              <>
                {/*
                 * The same control the product name pattern is edited in, and
                 * for the same reasons: fields as chips rather than syntax to
                 * be learnt, a list that offers them as you type, and each one
                 * showing what it comes to for a real order of the merchant's.
                 * Two patterns a merchant edits; one way of editing a pattern.
                 *
                 * No preview passed to it. What this pattern produces is stated
                 * once, in the row above.
                 */}
                <PatternEditor
                  label="Reference pattern"
                  value={form.customerOrderTemplate}
                  onChange={(next) => set("customerOrderTemplate", next)}
                  registry={ORDER_REFERENCE_REGISTRY}
                  rows={referenceRows}
                  details="Type a word — order, number, email — and the field offers itself. Leave it empty to use the default."
                  {...(badFields.length > 0
                    ? {
                        error: `${badFields.map((field) => `{${field}}`).join(", ")} ${badFields.length === 1 ? "is not a field" : "are not fields"} this app can fill in.`,
                      }
                    : {})}
                />

                {/*
                 * The same two buttons the name pattern carries, in the same
                 * order. Typing a word offers the fields on its own — no brace,
                 * no syntax — but that only helps once somebody has started, so
                 * the full list stays one click away for anyone who has not.
                 */}
                <s-stack direction="inline" gap="base" alignItems="center">
                  <s-button
                    type="button"
                    variant="secondary"
                    command="--show"
                    commandFor={REFERENCE_FIELDS_MODAL_ID}
                  >
                    What you can put in a reference
                  </s-button>
                  <s-button
                    type="button"
                    variant="secondary"
                    command="--show"
                    commandFor={REFERENCE_PATTERNS_MODAL_ID}
                  >
                    Start from a ready pattern
                  </s-button>
                </s-stack>
              </>
            ) : null}

            {/* Only when the fallback actually happened to this order. */}
            {preview?.usedFallback ? (
              <s-text color="subdued" tone="critical">
                That pattern produced nothing for this order, so the default was
                used. Orders with no customer email fall back the same way.
              </s-text>
            ) : null}

            <LearnMore label="What this reference is used for">
              <s-paragraph>
                This is what MetaKocka shows as <em>Customer&rsquo;s order</em>{" "}
                on the sales order.{" "}
                {unsplit
                  ? "It is also how this app finds a document again if a write times out."
                  : "It is also how the sales orders of one Shopify order are linked to each other when the order ships from more than one warehouse, and how this app finds a document again if a write times out."}
              </s-paragraph>
              <s-paragraph>
                It is a reference, not an identity. This app matches orders by
                their Shopify id, so changing the pattern is safe and never
                rewrites what MetaKocka already holds.
              </s-paragraph>
              {sample ? (
                <s-paragraph>
                  Orders already sent keep the reference they were sent with —
                  including {sample.name}, which carries {sample.currentRef}.
                  Changing this only affects orders that arrive from now on.
                </s-paragraph>
              ) : null}
            </LearnMore>
          </s-stack>
        </s-section>

        {/* ---------------------------------------------------------------
         * Shipping and discounts: the two amounts on a Shopify order that are
         * not products, and where each one goes.
         * --------------------------------------------------------------- */}
        <s-section heading="Shipping and discounts">
          <s-stack direction="block" gap="base">
            <s-box maxInlineSize="420px">
              <s-text-field
                name="shippingProductCode"
                label="Shipping product code"
                value={form.shippingProductCode}
                placeholder="e.g. SHIPPING"
                details="Checked against MetaKocka when you save."
                onChange={(event) =>
                  set("shippingProductCode", event.currentTarget.value)
                }
              />
            </s-box>

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
                  The document total matches what the customer paid.
                </s-text>
              </s-choice>
              <s-choice value="none">
                Do not write discounts
                <s-text slot="details">
                  The goods are shown at full price and the order is reported.
                </s-text>
              </s-choice>
            </s-choice-list>

            {/*
             * Contextual, and only while it is true of what is on screen: this
             * is the consequence of the two answers above it, so it belongs
             * with them rather than in a list of caveats somewhere else.
             */}
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

            <LearnMore label="Why these are asked for">
              <s-paragraph>
                MetaKocka sales orders carry products. Shipping and discounts
                are not products, so each needs somewhere to go before the sales
                order can add up to what the customer was charged.
              </s-paragraph>
              <s-paragraph>
                The shipping product code is the MetaKocka article a shipping
                charge is written against. It has to exist in MetaKocka already
                — this app never creates one from an order line.
              </s-paragraph>
              <s-paragraph>
                A discount written on the sales order uses MetaKocka&rsquo;s own
                discount field, as an amount, and comes off the document total.
                Left unwritten, the sales order shows the goods at full price
                and an order carrying a discount is reported as needing
                attention, because MetaKocka will not match what the customer
                was charged.
              </s-paragraph>
            </LearnMore>
          </s-stack>
        </s-section>

        {/* ---------------------------------------------------------------
         * Everything below is right for almost every shop and wrong for a few.
         * Closed, the card still answers itself: the summary says what the
         * settings inside currently are, so opening it is for changing rather
         * than for checking.
         *
         * Inside, one subsection per question a merchant might arrive with —
         * where things are fulfilled from, what happens when an order changes,
         * how payments are recorded — divided so a long card still reads as a
         * few short ones.
         * --------------------------------------------------------------- */}
        <AdvancedSection summary={advancedSummary}>
          <s-stack direction="block" gap="large-100">
            <s-stack direction="block" gap="base">
              <s-heading>Warehouse</s-heading>

              {/*
               * The question only exists for a shop that splits. Stating that
               * rather than showing a disabled control: the setting is kept,
               * because a shop switching back should find its old answer, and a
               * greyed-out radio pair invites a merchant to work out why it
               * will not move.
               */}
              {unsplit ? (
                <s-text color="subdued">
                  This shop writes one sales order for the whole order, with no
                  warehouse on it, so there is no warehouse to choose. Change
                  that under <s-text type="strong">Sales orders</s-text> above.
                </s-text>
              ) : (
                <>
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
                      </s-text>
                    </s-choice>
                    <s-choice value="stock_rules">
                      Stock levels
                      <s-text slot="details">
                        Choose from the stock this app has read: own warehouses
                        first, then partners.
                      </s-text>
                    </s-choice>
                  </s-choice-list>

                  {/*
                   * The overwrite-risk pattern from docs/ui-conventions.md: one
                   * standing line under the control, plus a banner that renders
                   * only in the unsaved-changes state, naming what will actually
                   * change.
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
                        Orders already sent are only rebuilt when something changes
                        them or you check them by hand. Nothing is re-sent in bulk.
                      </s-paragraph>
                    </s-banner>
                  ) : null}

                  {/*
                   * A sentence with a link rather than another Manage button: the
                   * card above already carries the row that goes to this page, and
                   * two buttons to one place is how a page starts to read as a
                   * menu.
                   */}
                  <s-text color="subdued">
                    Which MetaKocka warehouse a Shopify location means is set on the{" "}
                    <s-link href="/app/locations">Locations</s-link> page.
                  </s-text>

                  <LearnMore label="How the warehouse is chosen">
                    <s-paragraph>
                      <s-text type="strong">Shopify.</s-text> Moving an item to
                      another location in Shopify moves it to the mapped MetaKocka
                      warehouse, and the total across the sales orders stays exactly
                      what the customer ordered. Anything Shopify has not assigned —
                      a digital item, a fulfilment service this app cannot see —
                      falls back to stock levels.
                    </s-paragraph>
                    <s-paragraph>
                      <s-text type="strong">Stock levels.</s-text> Ignores
                      Shopify&rsquo;s assignment. For stores whose Shopify locations
                      do not correspond to how goods are actually warehoused. Stores
                      that were already running before Shopify locations were
                      supported stay on this until they choose otherwise.
                    </s-paragraph>
                    <s-paragraph>
                      A location with no warehouse mapped is reported rather than
                      guessed at.
                    </s-paragraph>
                  </LearnMore>
                </>
              )}
            </s-stack>

            <s-divider />

            <s-stack direction="block" gap="base">
              <s-heading>Order changes</s-heading>

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
                  {form.updateOnChange
                    ? "A changed order is rebuilt in MetaKocka and read back to confirm it."
                    : "A changed order is reported, and the document is left exactly as it was."}
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
                    orders.
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
                    The document is kept; it may already be invoiced.
                  </s-text>
                </s-choice>
                <s-choice value="report">
                  Report it and change nothing
                  <s-text slot="details">
                    The goods stay on it in MetaKocka until you deal with it.
                  </s-text>
                </s-choice>
                <s-choice value="delete_unpaid">
                  Delete it when nothing has been paid against it
                  <s-text slot="details">
                    One carrying a payment has its lines removed instead.
                  </s-text>
                </s-choice>
              </s-choice-list>

              <LearnMore label="What happens to a changed order">
                <s-paragraph>
                  A quantity changed, a line added or removed, a price
                  corrected: with updates on, the sales order in MetaKocka is
                  rebuilt to match and read back to confirm it. With them off,
                  the order is flagged as needing attention and the document is
                  left exactly as it was.
                </s-paragraph>
                <s-paragraph>
                  A paid document is the one most likely to have been invoiced,
                  and rewriting an invoiced document changes an accounting
                  record — which is why updating after payment is a separate
                  answer. It covers changes to the order itself; a payment
                  arriving later is always recorded.
                </s-paragraph>
                <s-paragraph>
                  When every item moves to another warehouse, the sales order
                  left behind is dealt with by the setting above: its lines
                  removed so it stops holding goods this order no longer takes
                  from there, left exactly as it is, or — only ever when nothing
                  has been paid against it — deleted. You are told either way,
                  and nothing else in this app deletes a MetaKocka document.
                </s-paragraph>
              </LearnMore>
            </s-stack>

            <s-divider />

            <s-stack direction="block" gap="base">
              <s-heading>Payments</s-heading>

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
                  {form.syncPayments
                    ? "Every successful Shopify payment is sent as its own entry."
                    : "What has been paid is shown on the order page, and nothing is written to MetaKocka."}
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
                        The parts always add back up to what was paid.
                      </s-text>
                    </s-choice>
                    <s-choice value="primary">
                      Put it all on the main sales order
                      <s-text slot="details">
                        The one carrying the shipping.
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
                        A deposit and a balance appear on their own dates.
                      </s-text>
                    </s-choice>
                    <s-choice value="aggregate">
                      One payment per payment type
                      <s-text slot="details">
                        Amounts added together, dated from the last one.
                      </s-text>
                    </s-choice>
                  </s-choice-list>

                  <s-text color="subdued">
                    Which MetaKocka payment type a Shopify gateway means is set
                    on the{" "}
                    <s-link href="/app/orders/settings/payments">
                      Payment types
                    </s-link>{" "}
                    page.
                  </s-text>

                  <LearnMore label="How payments are recorded">
                    <s-paragraph>
                      Every successful payment Shopify records is sent as its
                      own entry, so an order paid in two parts shows as two
                      payments for the right amounts. With payments off, what
                      has been paid is still shown on the order page and nothing
                      is written to MetaKocka.
                    </s-paragraph>
                    <s-paragraph>
                      A &euro;300 order split into a &euro;100 and a &euro;200
                      sales order records &euro;100 and &euro;200 when payments
                      are split by value. Putting it all on the main sales order
                      is for stores that treat the others as picking documents
                      and settle the order in one place.
                    </s-paragraph>
                    <s-paragraph>
                      One payment per payment type adds the amounts together and
                      dates them from the last one. Use it only if your
                      MetaKocka company refuses a sales order with more than one
                      payment on it.
                    </s-paragraph>
                    <s-paragraph>
                      A gateway with no type and no fallback is reported rather
                      than guessed at.
                    </s-paragraph>
                  </LearnMore>
                </>
              ) : null}
            </s-stack>

            <s-divider />

            <s-stack direction="block" gap="small-400">
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
                Puts the settings in this card back to what a new shop gets. It
                changes nothing until you save, and it never touches the
                shipping product or the discount setting, which are yours to
                choose.
              </s-text>
            </s-stack>
          </s-stack>
        </AdvancedSection>

        {/* ---------------------------------------------------------------
         * The promises this app keeps whatever the settings above say. One
         * line, and the list behind it: it is read once by a merchant deciding
         * whether to trust the thing, and after that it is in the way.
         * --------------------------------------------------------------- */}
        <s-section heading="Safety and reconciliation">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              Nothing is duplicated, invented or deleted behind your back. An
              order that cannot be represented exactly is reported rather than
              sent wrong.
            </s-text>

            <LearnMore label="What is never done automatically">
              <s-unordered-list>
                <s-list-item>
                  A second sales order is never created for an order that
                  already has one. When items move between warehouses the
                  existing sales orders are changed, never duplicated.
                </s-list-item>
                <s-list-item>
                  A MetaKocka document is never deleted, whatever happens in
                  Shopify — including a cancelled or deleted order. The one
                  exception is the setting in Order changes, which you have to
                  turn on, and which only ever removes an unpaid sales order
                  this order no longer uses.
                </s-list-item>
                <s-list-item>
                  Refunds and credit notes are never sent. A refund is recorded
                  in this app so what the customer has paid stays right, and
                  reported for you to credit in MetaKocka — a payment already
                  recorded is never shrunk to represent one.
                </s-list-item>
                <s-list-item>
                  A payment type is never guessed, and a card authorisation is
                  never treated as money received.
                </s-list-item>
                <s-list-item>
                  A shipping or discount article is never invented in MetaKocka.
                  If one is not configured, the order is reported rather than
                  sent with money missing and no mention of it.
                </s-list-item>
              </s-unordered-list>
            </LearnMore>
          </s-stack>
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
