import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  getFixedPartner,
  saveFixedPartner,
} from "~/adapters/db/repositories/sales-order-setting.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { partnerOverrideSchema } from "~/domain/orders/partner";
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
 */

type ActionResult = { ok: boolean; message: string };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const fixed = await getFixedPartner(principalFromSession(session));
  return {
    partner: fixed?.partner ?? null,
    resolved: fixed?.mkId !== null && fixed?.mkId !== undefined,
  };
};

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionResult> => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const formData = await request.formData();
  const intent = formData.get("intent");

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
  const { partner, resolved } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";

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
              The delivery address on each sales order is still the order&apos;s
              Shopify shipping address, and VAT (including OSS) is still decided
              by the customer&apos;s country. Customer details entered on a
              single order still win. Orders already in MetaKocka keep the
              customer they have.
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
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
