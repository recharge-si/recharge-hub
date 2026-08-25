import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useRef, useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";
import { z } from "zod";

import {
  NotPermittedError,
  disconnect,
  getCredential,
  getCredentialSummary,
  markVerified,
  saveCredential,
} from "~/adapters/db/repositories/metakocka-credential.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { MetakockaClient } from "~/adapters/metakocka/client";
import {
  MetakockaError,
  describeForMerchant,
} from "~/adapters/metakocka/errors";
import { listWarehouses } from "~/adapters/metakocka/warehouses";
import { getEnv } from "~/adapters/config/env.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import {
  isOwnershipKnown,
  principalFromSession,
} from "~/web/lib/principal.server";

/**
 * The MetaKocka connection screen (CLAUDE.md section 13, M2).
 *
 * The page never awaits MetaKocka on load (section 2.5): everything rendered
 * comes from our own database. Testing the connection is an explicit action the
 * merchant takes, not something that happens while the page is painting.
 */

const formSchema = z.object({
  companyId: z
    .string()
    .trim()
    .min(1, "Enter the company ID shown in MetaKocka under company settings."),
  secretKey: z.string().trim(),
  webhookClientSecret: z.string().trim(),
  apiUserEmail: z.string().trim(),
});

type FieldErrors = Partial<Record<"companyId" | "secretKey", string>>;

interface ActionResult {
  ok: boolean;
  intent: "save" | "test" | "disconnect";
  message?: string;
  fieldErrors?: FieldErrors;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  if (!principal.isShopOwner) {
    return {
      allowed: false as const,
      ownershipKnown: isOwnershipKnown(session),
      summary: null,
      stockWebhookUrl: "",
    };
  }

  return {
    allowed: true as const,
    ownershipKnown: true,
    summary: await getCredentialSummary(principal),
    /*
     * The URL to paste into MetaKocka's own webhook settings.
     *
     * MetaKocka has no idea what a Shopify store is, so the shop is in the path
     * and each store gets its own address. Built here rather than in the
     * browser because the app's public URL is configuration, not something a
     * page should infer from `window.location` — an embedded app is being
     * rendered inside admin.shopify.com.
     */
    stockWebhookUrl: `${getEnv().SHOPIFY_APP_URL.replace(/\/$/, "")}/webhooks/metakocka/${encodeURIComponent(principal.shopDomain)}/stock`,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "save");

  try {
    if (intent === "disconnect") {
      await disconnect(principal);
      await appendEvent(principal, {
        entityType: "metakocka_credential",
        event: "metakocka.disconnected",
      });

      return {
        ok: true,
        intent: "disconnect",
        message: "MetaKocka disconnected. No orders will be sent to the ERP.",
      } satisfies ActionResult;
    }

    if (intent === "test") {
      const credential = await getCredential(principal);
      if (!credential) {
        return {
          ok: false,
          intent: "test",
          message:
            "Save the company ID and secret key before testing the connection.",
        } satisfies ActionResult;
      }

      const client = new MetakockaClient(
        { companyId: credential.companyId, secretKey: credential.secretKey },
        // Well under the section 2.5 budget: this one is a merchant waiting on a
        // button, not a background job with a 60 second ceiling.
        { timeoutMs: 15_000 },
      );

      const warehouses = await listWarehouses(client);
      await markVerified(principal);
      await appendEvent(principal, {
        entityType: "metakocka_credential",
        event: "metakocka.connection_verified",
        detail: { warehouseCount: warehouses.length },
      });

      return {
        ok: true,
        intent: "test",
        message: `Connected. MetaKocka returned ${warehouses.length} ${
          warehouses.length === 1 ? "warehouse" : "warehouses"
        }.`,
      } satisfies ActionResult;
    }

    const parsed = formSchema.safeParse({
      companyId: formData.get("companyId") ?? "",
      secretKey: formData.get("secretKey") ?? "",
      webhookClientSecret: formData.get("webhookClientSecret") ?? "",
      apiUserEmail: formData.get("apiUserEmail") ?? "",
    });

    if (!parsed.success) {
      const fieldErrors: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === "companyId" || field === "secretKey") {
          fieldErrors[field] ??= issue.message;
        }
      }
      return { ok: false, intent: "save", fieldErrors } satisfies ActionResult;
    }

    const summary = await getCredentialSummary(principal);
    if (!summary.connected && parsed.data.secretKey === "") {
      return {
        ok: false,
        intent: "save",
        fieldErrors: {
          secretKey:
            "Enter the secret key from MetaKocka. It is required to connect.",
        },
      } satisfies ActionResult;
    }

    await saveCredential(principal, {
      companyId: parsed.data.companyId,
      ...(parsed.data.secretKey ? { secretKey: parsed.data.secretKey } : {}),
      ...(parsed.data.webhookClientSecret
        ? { webhookClientSecret: parsed.data.webhookClientSecret }
        : {}),
      apiUserEmail: parsed.data.apiUserEmail,
    });

    await appendEvent(principal, {
      entityType: "metakocka_credential",
      event: "metakocka.credentials_saved",
      detail: { companyId: parsed.data.companyId },
    });

    return {
      ok: true,
      intent: "save",
      message: "Saved. Test the connection to confirm the credentials work.",
    } satisfies ActionResult;
  } catch (error) {
    if (error instanceof NotPermittedError) {
      return {
        ok: false,
        intent: intent as ActionResult["intent"],
        message: error.message,
      } satisfies ActionResult;
    }

    if (error instanceof MetakockaError) {
      return {
        ok: false,
        intent: intent as ActionResult["intent"],
        message: describeForMerchant(error),
      } satisfies ActionResult;
    }

    throw error;
  }
};

export default function MetakockaSettings() {
  const { allowed, ownershipKnown, summary, stockWebhookUrl } =
    useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  const [companyId, setCompanyId] = useState(summary?.companyId ?? "");
  const [secretKey, setSecretKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [apiUserEmail, setApiUserEmail] = useState(summary?.apiUserEmail ?? "");
  const formRef = useRef<HTMLFormElement>(null);

  // The contextual save bar fires `reset` on Discard. Put the fields back to
  // what is stored rather than to empty strings.
  useEffect(() => {
    const form = formRef.current;
    if (!form) return;

    const handleReset = () => {
      setCompanyId(summary?.companyId ?? "");
      setSecretKey("");
      setWebhookSecret("");
      setApiUserEmail(summary?.apiUserEmail ?? "");
    };

    form.addEventListener("reset", handleReset);
    return () => form.removeEventListener("reset", handleReset);
  }, [summary?.companyId, summary?.apiUserEmail]);

  if (!allowed) {
    return (
      <s-page heading="MetaKocka connection">
        <s-section heading="Store owner only">
          <s-banner tone="warning">
            <s-paragraph>
              {ownershipKnown
                ? "Only the store owner can view or change the MetaKocka connection, because the secret key gives full access to the ERP."
                : "Shopify did not confirm which user you are, so this screen stays closed. Open the app again from the Shopify admin, and if this keeps happening, sign in as the store owner."}
            </s-paragraph>
          </s-banner>
        </s-section>
      </s-page>
    );
  }

  const saveErrors = result?.intent === "save" ? result.fieldErrors : undefined;
  const banner = result?.message ? result : undefined;

  return (
    <s-page heading="MetaKocka connection">
      {/*
        One stack owns every vertical gap on this page.

        `s-page` spaces its own direct children, but the form sections are
        nested inside a `form` element and never receive that spacing, so they
        would sit flush against each other while the status card below kept its
        gap. Rather than mix the two, the page has a single child and all
        spacing comes from Polaris tokens here (CLAUDE.md section 2.6: Polaris
        spacing tokens, no custom styling).
      */}
      <s-stack direction="block" gap="large">
        {banner ? (
          <s-banner tone={banner.ok ? "success" : "critical"}>
            <s-paragraph>{banner.message}</s-paragraph>
          </s-banner>
        ) : null}

        <Form method="post" data-save-bar ref={formRef}>
          <input type="hidden" name="intent" value="save" />
          <s-stack direction="block" gap="large">
            <s-section heading="Credentials">
              <s-stack direction="block" gap="base">
                <s-box maxInlineSize="520px">
                  <s-stack direction="block" gap="base">
                    <s-text-field
                      name="companyId"
                      label="Company ID"
                      details="Shown in MetaKocka under company settings."
                      value={companyId}
                      onChange={(event) =>
                        setCompanyId(event.currentTarget.value)
                      }
                      error={saveErrors?.companyId}
                    />
                    <s-password-field
                      name="secretKey"
                      label="Secret key"
                      value={secretKey}
                      onChange={(event) =>
                        setSecretKey(event.currentTarget.value)
                      }
                      details={
                        summary?.secretKeyMask
                          ? `A key ending ${summary.secretKeyMask} is saved. Leave blank to keep it.`
                          : "Paste the key generated in MetaKocka."
                      }
                      error={saveErrors?.secretKey}
                    />
                  </s-stack>
                </s-box>
                <s-paragraph>
                  The secret key grants full read and write access to this
                  MetaKocka company. It is encrypted before it is stored and
                  never shown again.
                </s-paragraph>
                <s-link
                  href="https://metakocka.freshdesk.com/en/support/solutions/articles/3000106126-obtaining-api-key-and-company-id"
                  target="_blank"
                >
                  How to find your API key and company ID in MetaKocka
                </s-link>
              </s-stack>
            </s-section>

            <s-section heading="Writing stock back to MetaKocka">
              <s-box maxInlineSize="520px">
                <s-stack direction="block" gap="base">
                  <s-email-field
                    name="apiUserEmail"
                    label="MetaKocka API user email"
                    value={apiUserEmail}
                    onChange={(event) =>
                      setApiUserEmail(event.currentTarget.value)
                    }
                    details="Only needed for warehouses counted in Shopify. MetaKocka requires it before it will accept a stock update."
                  />
                </s-stack>
              </s-box>
            </s-section>

            <s-section heading="Stock webhook">
              <s-stack direction="block" gap="base">
                <s-paragraph>
                  Stock is read from MetaKocka every five minutes. Registering
                  this webhook makes most changes arrive in seconds instead.
                </s-paragraph>

                {/*
                  * The URL, shown so it can be copied.
                  *
                  * Read-only rather than a link: it is not something to open,
                  * it is something to paste into MetaKocka.
                  */}
                <s-box maxInlineSize="640px">
                  <s-text-field
                    label="Webhook URL for MetaKocka"
                    name="stockWebhookUrl"
                    value={stockWebhookUrl}
                    readOnly
                    details="Paste this into the webhook settings in MetaKocka, for the warehouse product stock update event."
                  />
                </s-box>

                <s-box maxInlineSize="520px">
                  <s-password-field
                    name="webhookClientSecret"
                    label="Webhook client secret"
                    value={webhookSecret}
                    onChange={(event) =>
                      setWebhookSecret(event.currentTarget.value)
                    }
                    details={
                      summary?.webhookSecretSet
                        ? "A secret is saved. Leave blank to keep it."
                        : "MetaKocka shows this when you register the webhook. Without it, stock updates from MetaKocka are refused, because there is no way to tell they came from MetaKocka."
                    }
                  />
                </s-box>
              </s-stack>
            </s-section>
          </s-stack>
        </Form>

        <s-section heading="Connection status">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-badge tone={summary?.lastVerifiedAt ? "success" : "caution"}>
                {summary?.lastVerifiedAt ? "Verified" : "Not verified"}
              </s-badge>
              <s-text>
                {summary?.lastVerifiedAt
                  ? `Last successful call ${new Date(summary.lastVerifiedAt).toLocaleString()}`
                  : "The credentials have not been used successfully yet."}
              </s-text>
            </s-stack>

            <s-stack direction="inline" gap="base">
              <Form method="post">
                <input type="hidden" name="intent" value="test" />
                <s-button type="submit" {...(busy ? { disabled: true } : {})}>
                  Test connection
                </s-button>
              </Form>

              {summary?.connected ? (
                <Form method="post">
                  <input type="hidden" name="intent" value="disconnect" />
                  <s-button
                    type="submit"
                    variant="secondary"
                    tone="critical"
                    {...(busy ? { disabled: true } : {})}
                  >
                    Disconnect
                  </s-button>
                </Form>
              ) : null}
            </s-stack>
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
