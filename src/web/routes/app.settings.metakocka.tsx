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
    };
  }

  return {
    allowed: true as const,
    ownershipKnown: true,
    summary: await getCredentialSummary(principal),
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
  const { allowed, ownershipKnown, summary } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  const [companyId, setCompanyId] = useState(summary?.companyId ?? "");
  const [secretKey, setSecretKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
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
    };

    form.addEventListener("reset", handleReset);
    return () => form.removeEventListener("reset", handleReset);
  }, [summary?.companyId]);

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
      {banner ? (
        <s-banner tone={banner.ok ? "success" : "critical"}>
          <s-paragraph>{banner.message}</s-paragraph>
        </s-banner>
      ) : null}

      <Form method="post" data-save-bar ref={formRef}>
        <input type="hidden" name="intent" value="save" />

        <s-section heading="Company">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Your MetaKocka company ID identifies which company this store
              writes to. You can find it in MetaKocka under company settings.
            </s-paragraph>
            <s-text-field
              name="companyId"
              label="Company ID"
              value={companyId}
              onChange={(event) => setCompanyId(event.currentTarget.value)}
              error={saveErrors?.companyId}
            />
          </s-stack>
        </s-section>

        <s-section heading="Secret key">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              The secret key lets this app create sales orders and read stock in
              your MetaKocka company. MetaKocka issues one key per company with
              full read and write access, so treat it like a password. It is
              encrypted before it is stored and is never shown again.
            </s-paragraph>
            <s-password-field
              name="secretKey"
              label="Secret key"
              value={secretKey}
              onChange={(event) => setSecretKey(event.currentTarget.value)}
              details={
                summary?.secretKeyMask
                  ? `A key ending ${summary.secretKeyMask} is saved. Leave this blank to keep it.`
                  : "Generate a key in MetaKocka, then paste it here."
              }
              error={saveErrors?.secretKey}
            />
            <s-link
              href="https://metakocka.freshdesk.com/"
              target="_blank"
            >
              How to generate a secret key in MetaKocka
            </s-link>
          </s-stack>
        </s-section>

        <s-section heading="Stock webhook">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Optional. MetaKocka signs its stock update webhook with a separate
              client secret. Add it once you have registered the webhook, so this
              app can verify that incoming stock updates really came from
              MetaKocka.
            </s-paragraph>
            <s-password-field
              name="webhookClientSecret"
              label="Webhook client secret"
              value={webhookSecret}
              onChange={(event) => setWebhookSecret(event.currentTarget.value)}
              details={
                summary?.webhookSecretSet
                  ? "A secret is saved. Leave this blank to keep it."
                  : "Leave blank if you have not registered the webhook yet."
              }
            />
          </s-stack>
        </s-section>
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
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
