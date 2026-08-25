import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  getSalesOrderSettings,
  saveSalesOrderSettings,
} from "~/adapters/db/repositories/sales-order-setting.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { principalFromSession } from "~/web/lib/principal.server";

/**
 * What happens to a MetaKocka sales order after it has been sent.
 *
 * There is exactly one decision on this page and it is a real one, which is why
 * it is a page rather than a checkbox buried in another. §8.8 originally said an
 * order that changes in Shopify after it has been written is a person's
 * problem — never touch the document. That is the cautious reading, and in
 * practice it meant the ERP went on holding quantities nobody had agreed to
 * while the merchant looked at an exception they could not act on.
 *
 * The other reading is that a sales order is a description of an order, and a
 * description that has stopped being true should be corrected. Both are
 * defensible; which is right depends on something only the merchant knows —
 * whether they invoice from these documents, and how quickly.
 */
const HELP_MODAL_ID = "about-sales-orders";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  return { settings: await getSalesOrderSettings(principal) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const formData = await request.formData();
  const updateOnChange = formData.get("updateOnChange") === "on";
  const updateAfterPaid = formData.get("updateAfterPaid") === "on";

  await saveSalesOrderSettings(principal, {
    updateOnChange,
    // Meaningless on its own, and storing it as true while updates are off
    // would turn itself on the moment they were switched back.
    updateAfterPaid: updateOnChange && updateAfterPaid,
  });

  await appendEvent(principal, {
    entityType: "sales_order_setting",
    event: "sales_order.settings_saved",
    detail: { updateOnChange, updateAfterPaid },
  });

  return { ok: true, message: "Saved sales order settings." };
};

export default function SalesOrderSettings() {
  const { settings } = useLoaderData<typeof loader>();
  const saver = useFetcher<typeof action>();
  const result = saver.data;
  const busy = saver.state !== "idle";

  const [updateOnChange, setUpdateOnChange] = useState(settings.updateOnChange);
  const [updateAfterPaid, setUpdateAfterPaid] = useState(
    settings.updateAfterPaid,
  );

  const dirty =
    updateOnChange !== settings.updateOnChange ||
    updateAfterPaid !== settings.updateAfterPaid;

  /*
   * The contextual save bar, driven by hand (§2.6: saving goes through it, and
   * never through a bespoke Save button in a card). `data-save-bar` watches for
   * change events, which a value React writes onto a custom element does not
   * fire — so the bar is opened and closed from the same comparison the submit
   * uses, exactly as the payment types page does.
   */
  useEffect(() => {
    if (typeof shopify === "undefined") return;
    if (dirty) void shopify.saveBar.show("sales-order-save-bar");
    else void shopify.saveBar.hide("sales-order-save-bar");
  }, [dirty]);

  useEffect(() => {
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [result]);

  const save = () =>
    saver.submit(
      {
        updateOnChange: updateOnChange ? "on" : "",
        updateAfterPaid: updateAfterPaid ? "on" : "",
      },
      { method: "post" },
    );

  const discard = () => {
    setUpdateOnChange(settings.updateOnChange);
    setUpdateAfterPaid(settings.updateAfterPaid);
  };

  return (
    <s-page heading="Sales orders">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>

      <s-button
        slot="secondary-actions"
        icon="question-circle"
        command="--show"
        commandFor={HELP_MODAL_ID}
      >
        Help
      </s-button>

      <s-modal id={HELP_MODAL_ID} heading="About updating sales orders">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            MetaKocka has no way to change part of a document. An update
            replaces the whole sales order with what is sent, so this app
            rebuilds the document from the order as it now stands and swaps it,
            then reads it back to check every line survived.
          </s-paragraph>
          <s-paragraph>
            A second sales order is never created for the same order. The
            document keeps its MetaKocka number and its reference, and any
            payment already recorded against it is put back on.
          </s-paragraph>
          <s-paragraph>
            If a change moves a whole line to a different warehouse, the
            document for the old one is left alone and reported as an exception.
            Nothing is ever deleted in MetaKocka.
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

      <ui-save-bar id="sales-order-save-bar">
        <button variant="primary" onClick={save} disabled={busy}>
          Save
        </button>
        <button onClick={discard} disabled={busy}>
          Discard
        </button>
      </ui-save-bar>

      <s-stack direction="block" gap="large">
        <s-section heading="When a Shopify order changes">
          <s-stack direction="block" gap="base">
            <s-stack direction="block" gap="small-400">
              <s-checkbox
                name="updateOnChange"
                value="on"
                label="Update the MetaKocka sales order"
                checked={updateOnChange}
                onChange={(event) =>
                  setUpdateOnChange(event.currentTarget.checked)
                }
              />
              <s-text color="subdued">
                A quantity changed, a line added or removed, a price corrected:
                the sales order in MetaKocka is rebuilt to match and read back
                to confirm it. With this off, the order is flagged as needing
                attention and the document is left exactly as it was.
              </s-text>
            </s-stack>

            {updateOnChange ? (
              <s-stack direction="block" gap="small-400">
                <s-checkbox
                  name="updateAfterPaid"
                  value="on"
                  label="Update it even after the payment has been recorded"
                  checked={updateAfterPaid}
                  onChange={(event) =>
                    setUpdateAfterPaid(event.currentTarget.checked)
                  }
                />
                <s-text color="subdued">
                  Leave this off if you issue invoices from these sales orders.
                  A paid document is the one most likely to have been invoiced,
                  and rewriting an invoiced document changes an accounting
                  record. With it off, a change to a paid order is reported for
                  you to handle rather than sent.
                </s-text>
              </s-stack>
            ) : null}
          </s-stack>
        </s-section>

        <s-section heading="What is never done automatically">
          {/*
            * Stated plainly, because the limits are the reason the merchant can
            * trust the rest. §8.8's one absolute rule is here.
            */}
          <s-unordered-list>
            <s-list-item>
              A document is never deleted in MetaKocka, whatever happens in
              Shopify — including a cancelled or deleted order.
            </s-list-item>
            <s-list-item>
              A second sales order is never created for an order that already
              has one.
            </s-list-item>
            <s-list-item>
              Refunds and credit notes are never sent. They are reported for you
              to issue in MetaKocka.
            </s-list-item>
          </s-unordered-list>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
