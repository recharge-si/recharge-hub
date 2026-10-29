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
  ExportPortalNotPermittedError,
  disconnectExportPortal,
  getExportPortalSummary,
  saveExportPortalApiKey,
} from "~/adapters/db/repositories/export-portal-connection.server";
import {
  isPortalConfigured,
  portalFailure,
  portalFor,
  verifyConnection,
} from "~/adapters/export-portal/service.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { ConfirmModal } from "~/web/components/confirm-modal";
import { SourcesNav } from "~/web/components/sources-nav";
import { formatDateTime } from "~/web/lib/datetime";
import {
  actorFromSession,
  isOwnershipKnown,
  principalFromSession,
} from "~/web/lib/principal.server";
import { redirectWithin } from "~/web/lib/redirects";
import { SOURCE_ROUTES } from "~/web/lib/sources";

/**
 * The export portal connection (docs/sources.md § Connection): one API key,
 * generated in the portal's own admin for this store and pasted here.
 *
 * Saving the key tests it at once — the portal says which tenant it is and
 * that it was issued for this shop — so a wrong key is found while the
 * person is still looking at the field. Disconnecting forgets the key and
 * nothing else: the sources live in the portal and are untouched.
 */
const DISCONNECT_MODAL_ID = "disconnect-export-portal";

interface ActionResult {
  ok: boolean;
  intent: "save" | "test" | "disconnect";
  message: string;
  fieldError?: string;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);

  if (!principal.isShopOwner) {
    return {
      allowed: false as const,
      ownershipKnown: isOwnershipKnown(session),
      configured: isPortalConfigured(),
      summary: null,
      shopDomain: session.shop,
    };
  }

  return {
    allowed: true as const,
    ownershipKnown: true,
    configured: isPortalConfigured(),
    summary: await getExportPortalSummary(principal),
    shopDomain: session.shop,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const actor = actorFromSession(session);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "save");

  try {
    if (intent === "disconnect") {
      const removed = await disconnectExportPortal(principal);
      if (!removed) {
        return {
          ok: false,
          intent: "disconnect",
          message: "There is no export portal connection to disconnect.",
        } satisfies ActionResult;
      }
      await appendEvent(principal, {
        entityType: "export_portal_connection",
        event: "export_portal.disconnected",
        detail: { actor },
      });
      return redirectWithin(request, SOURCE_ROUTES.index, {
        note: "Disconnected from the export portal. The sources themselves are unchanged in the portal.",
      });
    }

    if (intent === "test") {
      const access = await portalFor(principal, { timeoutMs: 15_000 });
      if (!access.ok) {
        return {
          ok: false,
          intent: "test",
          message: access.message,
        } satisfies ActionResult;
      }
      try {
        const connection = await verifyConnection(access.client, principal);
        await appendEvent(principal, {
          entityType: "export_portal_connection",
          event: "export_portal.connection_verified",
          detail: { tenantId: connection.tenant.id, actor },
        });
        return {
          ok: true,
          intent: "test",
          message: `Connected. The portal knows this store as ${connection.tenant.name}.`,
        } satisfies ActionResult;
      } catch (error) {
        return {
          ok: false,
          intent: "test",
          message: portalFailure(error).message,
        } satisfies ActionResult;
      }
    }

    const apiKey = String(formData.get("apiKey") ?? "").trim();
    if (apiKey === "") {
      return {
        ok: false,
        intent: "save",
        message: "Paste the API key generated in the export portal.",
        fieldError: "Paste the API key generated in the export portal.",
      } satisfies ActionResult;
    }

    await saveExportPortalApiKey(principal, apiKey);
    await appendEvent(principal, {
      entityType: "export_portal_connection",
      event: "export_portal.key_saved",
      detail: { actor },
    });

    // Tested at once, so a wrong key is found now rather than on the next
    // page. The key stays saved either way: the person can see what the
    // portal said and paste again.
    const access = await portalFor(principal, { timeoutMs: 15_000 });
    if (!access.ok) {
      return {
        ok: false,
        intent: "save",
        message: `Saved, but it could not be tested: ${access.message}`,
      } satisfies ActionResult;
    }
    try {
      const connection = await verifyConnection(access.client, principal);
      await appendEvent(principal, {
        entityType: "export_portal_connection",
        event: "export_portal.connection_verified",
        detail: { tenantId: connection.tenant.id, actor },
      });
      return {
        ok: true,
        intent: "save",
        message: `Connected. The portal knows this store as ${connection.tenant.name}.`,
      } satisfies ActionResult;
    } catch (error) {
      return {
        ok: false,
        intent: "save",
        message: `The key was saved, but the portal did not accept it. ${portalFailure(error).message}`,
      } satisfies ActionResult;
    }
  } catch (error) {
    if (error instanceof ExportPortalNotPermittedError) {
      return {
        ok: false,
        intent: intent === "test" || intent === "disconnect" ? intent : "save",
        message: error.message,
      } satisfies ActionResult;
    }
    throw error;
  }
};

export default function SourcesConnection() {
  const { allowed, ownershipKnown, configured, summary, shopDomain } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data;
  const busy = fetcher.state !== "idle";
  const [apiKey, setApiKey] = useState("");

  // A saved key is not kept in the field: the mask below says it is there.
  useEffect(() => {
    if (result?.ok && result.intent === "save") setApiKey("");
    // A result that went well is a toast; only a failure keeps a banner.
    if (result?.ok && result.message && typeof shopify !== "undefined")
      shopify.toast.show(result.message);
  }, [result]);

  if (!allowed) {
    return (
      <s-page heading="Export portal connection">
        <s-link slot="breadcrumb-actions" href={SOURCE_ROUTES.index}>
          Sources
        </s-link>
        <s-section heading="Store owner only">
          <s-banner tone="warning">
            <s-paragraph>
              {ownershipKnown
                ? "Only the store owner can view or change the export portal connection, because the API key configures what the portal writes into the store."
                : "Shopify did not confirm which user you are, so this screen stays closed. Open the app again from the Shopify admin, and if this keeps happening, sign in as the store owner."}
            </s-paragraph>
          </s-banner>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Export portal connection">
      <s-link slot="breadcrumb-actions" href={SOURCE_ROUTES.index}>
        Sources
      </s-link>

      <SourcesNav current="connection" />

      <s-stack direction="block" gap="large">
        {!configured ? (
          <s-banner
            tone="warning"
            heading="The export portal is not configured on this server"
          >
            <s-paragraph>
              Set EXPORT_PORTAL_URL in the server environment to the
              portal&apos;s address. A key can be saved now and is tested once
              the address is set.
            </s-paragraph>
          </s-banner>
        ) : null}

        {result?.message && !result.ok ? (
          <s-banner tone="critical">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        <s-section heading="API key">
          <s-stack direction="block" gap="base">
            <s-box maxInlineSize="520px">
              <s-password-field
                name="apiKey"
                label="API key"
                value={apiKey}
                onChange={(event) => setApiKey(event.currentTarget.value)}
                details={
                  summary?.apiKeyMask
                    ? `A key ending ${summary.apiKeyMask} is saved. Paste a new one to replace it.`
                    : "Generated in the export portal's admin, under the store's API keys."
                }
                {...(result?.fieldError ? { error: result.fieldError } : {})}
                {...(busy ? { disabled: true } : {})}
              />
            </s-box>
            <s-paragraph>
              The key is issued for <s-text type="strong">{shopDomain}</s-text>{" "}
              and lets this app read and change the store&apos;s sources in the
              portal. It is encrypted before it is stored and never shown again.
            </s-paragraph>
            <s-stack direction="inline" gap="base">
              <s-button
                variant="primary"
                onClick={() =>
                  fetcher.submit({ intent: "save", apiKey }, { method: "post" })
                }
                {...(busy || apiKey.trim() === "" ? { disabled: true } : {})}
                {...(busy && fetcher.formData?.get("intent") === "save"
                  ? { loading: true }
                  : {})}
              >
                {summary?.connected ? "Replace key" : "Connect"}
              </s-button>
              {summary?.connected ? (
                <s-button
                  onClick={() =>
                    fetcher.submit({ intent: "test" }, { method: "post" })
                  }
                  {...(busy ? { disabled: true } : {})}
                  {...(busy && fetcher.formData?.get("intent") === "test"
                    ? { loading: true }
                    : {})}
                >
                  Test connection
                </s-button>
              ) : null}
            </s-stack>
          </s-stack>
        </s-section>

        <s-section heading="Connection status">
          <s-stack direction="block" gap="small-300">
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-badge
                {...(summary?.lastVerifiedAt
                  ? {}
                  : { tone: summary?.connected ? "caution" : "neutral" })}
              >
                {summary?.lastVerifiedAt
                  ? "Verified"
                  : summary?.connected
                    ? "Not verified"
                    : "Not connected"}
              </s-badge>
              <s-text>
                {summary?.lastVerifiedAt
                  ? `Last successful call ${formatDateTime(summary.lastVerifiedAt)}`
                  : summary?.connected
                    ? "The key has not been used yet."
                    : "No key is saved."}
              </s-text>
            </s-stack>
            {summary?.tenantName ? (
              <s-text color="subdued">
                {`The portal knows this store as ${summary.tenantName}.`}
              </s-text>
            ) : null}
          </s-stack>
        </s-section>

        {summary?.connected ? (
          <s-section heading="Disconnect">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Forgets the key. The sources, their settings and their runs stay
                in the export portal exactly as they are; this app just stops
                showing them until a key is pasted again.
              </s-paragraph>
              <s-stack direction="inline">
                <s-button
                  variant="secondary"
                  tone="critical"
                  command="--show"
                  commandFor={DISCONNECT_MODAL_ID}
                  {...(busy ? { disabled: true } : {})}
                >
                  Disconnect
                </s-button>
              </s-stack>
              <ConfirmModal
                id={DISCONNECT_MODAL_ID}
                heading="Disconnect from the export portal?"
                confirmLabel="Disconnect"
                onConfirm={() =>
                  fetcher.submit({ intent: "disconnect" }, { method: "post" })
                }
              >
                <s-paragraph>
                  The saved key is forgotten. Nothing in the portal changes.
                </s-paragraph>
              </ConfirmModal>
            </s-stack>
          </s-section>
        ) : null}
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
