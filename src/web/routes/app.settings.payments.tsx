import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useRef, useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";
import { z } from "zod";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  listPaymentTypeMaps,
  replacePaymentTypeMaps,
} from "~/adapters/db/repositories/payment-type-map.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { principalFromSession } from "~/web/lib/principal.server";

/**
 * Shopify payment gateway to MetaKocka payment type (CLAUDE.md §8.7).
 *
 * `payment_type` has to match a type in the merchant's MetaKocka register and no
 * endpoint lists them, so both sides are typed by the merchant. An unmapped
 * gateway raises an exception when an order arrives rather than being guessed.
 */
const rowSchema = z.object({
  shopifyGateway: z.string().trim().min(1),
  metakockaPaymentType: z.string().trim().min(1),
});

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const maps = await listPaymentTypeMaps(principal);

  return {
    mappings: maps.map((row) => ({
      shopifyGateway: row.shopifyGateway,
      metakockaPaymentType: row.metakockaPaymentType,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const formData = await request.formData();
  const gateways = formData.getAll("shopifyGateway").map(String);
  const types = formData.getAll("metakockaPaymentType").map(String);

  const rows: Array<z.infer<typeof rowSchema>> = [];
  const seen = new Set<string>();
  let error: string | null = null;

  for (let index = 0; index < gateways.length; index += 1) {
    const candidate = {
      shopifyGateway: (gateways[index] ?? "").trim(),
      metakockaPaymentType: (types[index] ?? "").trim(),
    };

    // A row where both sides are blank is just an unused slot.
    if (!candidate.shopifyGateway && !candidate.metakockaPaymentType) continue;

    const parsed = rowSchema.safeParse(candidate);
    if (!parsed.success) {
      error =
        "Every row needs both a Shopify gateway and a MetaKocka payment type. Remove the row if you do not need it.";
      break;
    }

    const key = parsed.data.shopifyGateway.toLowerCase();
    if (seen.has(key)) {
      error = `The gateway "${parsed.data.shopifyGateway}" is listed twice. Each gateway maps to exactly one payment type.`;
      break;
    }
    seen.add(key);
    rows.push(parsed.data);
  }

  if (error) return { ok: false, message: error };

  await replacePaymentTypeMaps(principal, rows);
  await appendEvent(principal, {
    entityType: "payment_type_map",
    event: "payment_types.saved",
    detail: { count: rows.length },
  });

  return { ok: true, message: `Saved ${rows.length} mapping${rows.length === 1 ? "" : "s"}.` };
};

interface Row {
  shopifyGateway: string;
  metakockaPaymentType: string;
}

/** Always show at least one row, so an empty mapping is still editable. */
function toRows(mappings: Row[]): Row[] {
  return mappings.length > 0
    ? mappings.map((m) => ({ ...m }))
    : [{ shopifyGateway: "", metakockaPaymentType: "" }];
}

export default function PaymentSettings() {
  const { mappings } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const formRef = useRef<HTMLFormElement>(null);

  const [rows, setRows] = useState<Row[]>(() => toRows(mappings));

  useEffect(() => {
    const form = formRef.current;
    if (!form) return;

    // Derived from `mappings` inside the handler, so Discard always restores
    // what is stored rather than a value captured from an earlier render.
    const handleReset = () => setRows(toRows(mappings));

    form.addEventListener("reset", handleReset);
    return () => form.removeEventListener("reset", handleReset);
  }, [mappings]);

  const update = (index: number, patch: Partial<Row>) =>
    setRows((current) =>
      current.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );

  return (
    <s-page heading="Payment types">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>

      <s-stack direction="block" gap="large">
        {result?.message ? (
          <s-banner tone={result.ok ? "success" : "critical"}>
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        <Form method="post" data-save-bar ref={formRef}>
          <s-section heading="Gateway mapping">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Each Shopify payment gateway needs the MetaKocka payment type it
                corresponds to, typed exactly as it appears in MetaKocka. An order
                paid through a gateway that is not listed here raises an exception
                instead of being guessed.
              </s-paragraph>

              {rows.map((row, index) => (
                <s-box key={index} maxInlineSize="720px">
                  <s-stack direction="inline" gap="base" alignItems="end">
                    <s-text-field
                      name="shopifyGateway"
                      label="Shopify gateway"
                      details={index === 0 ? "For example: shopify_payments, cash_on_delivery, gift_card" : undefined}
                      value={row.shopifyGateway}
                      onChange={(e) =>
                        update(index, { shopifyGateway: e.currentTarget.value })
                      }
                    />
                    <s-text-field
                      name="metakockaPaymentType"
                      label="MetaKocka payment type"
                      details={index === 0 ? "Must already exist in your MetaKocka payment register." : undefined}
                      value={row.metakockaPaymentType}
                      onChange={(e) =>
                        update(index, {
                          metakockaPaymentType: e.currentTarget.value,
                        })
                      }
                    />
                    <s-button
                      type="button"
                      variant="secondary"
                      onClick={() =>
                        setRows((current) =>
                          current.length === 1
                            ? [{ shopifyGateway: "", metakockaPaymentType: "" }]
                            : current.filter((_, i) => i !== index),
                        )
                      }
                    >
                      Remove
                    </s-button>
                  </s-stack>
                </s-box>
              ))}

              <s-button
                type="button"
                variant="secondary"
                onClick={() =>
                  setRows((current) => [
                    ...current,
                    { shopifyGateway: "", metakockaPaymentType: "" },
                  ])
                }
              >
                Add mapping
              </s-button>
            </s-stack>
          </s-section>
        </Form>

        <s-section heading="Cash on delivery">
          <s-paragraph>
            Cash on delivery is not paid when the order is placed. Map it here so
            the document carries the right payment type, and the order is left
            unpaid in MetaKocka until the money actually arrives.
          </s-paragraph>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
