import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  useRevalidator,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  portalFailure,
  portalFor,
} from "~/adapters/export-portal/service.server";
import { countReviewProducts } from "~/adapters/shopify/review-products";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { reviewQuery } from "~/domain/export-portal/review";
import type { SourceSummary } from "~/domain/export-portal/contract";
import { ConfirmModal } from "~/web/components/confirm-modal";
import { SourcesNav } from "~/web/components/sources-nav";
import { SourcesSummary, SourcesTable } from "~/web/components/sources-list";
import {
  actorFromSession,
  principalFromSession,
} from "~/web/lib/principal.server";
import { useLiveRevalidation, useWatchWindow } from "~/web/lib/live";
import { SOURCE_ROUTES, summarizeSources } from "~/web/lib/sources";
import { loadSourcesShell, readPortal } from "~/web/lib/sources.server";

/**
 * Sources (docs/sources.md § Screens): every export the store has in the
 * export portal, whether each is working, when it last ran and when it
 * runs next. Everything on the page is the portal's answer to one call;
 * nothing about a source is stored here.
 *
 * The page opens with the figures every page that owns a background
 * process answers (docs/ui-conventions.md § Page header): healthy or not,
 * the last run, the next run. Then one table, and from each row the
 * things a person does without opening the source: run it, turn it off,
 * delete it.
 */
const HELP_MODAL_ID = "about-sources";
const DELETE_MODAL_ID = "delete-source";

interface ActionResult {
  ok: boolean;
  message: string;
  /** A run was asked for; the page watches until the portal lists it. */
  started?: boolean;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const url = new URL(request.url);
  const [shell, portal, awaitingReview] = await Promise.all([
    loadSourcesShell(principal),
    readPortal(principal, (client) => client.listSources()),
    // What is waiting is Shopify's answer, not the portal's; a failed count
    // hides the banner rather than the page.
    countReviewProducts(admin, reviewQuery({})).catch(() => 0),
  ]);
  return {
    shell,
    portal,
    awaitingReview,
    note: url.searchParams.get("note"),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const actor = actorFromSession(session);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const sourceId = String(formData.get("sourceId") ?? "");

  const access = await portalFor(principal);
  if (!access.ok)
    return { ok: false, message: access.message } satisfies ActionResult;
  if (!sourceId)
    return { ok: false, message: "Unknown action." } satisfies ActionResult;

  try {
    if (intent === "run") {
      const run = await access.client.startRun(sourceId);
      await appendEvent(principal, {
        entityType: "export_source",
        entityId: sourceId,
        event: "export_source.run_requested",
        detail: { runId: run.id, actor },
      });
      return {
        ok: true,
        message: "Run started in the export portal.",
        started: true,
      } satisfies ActionResult;
    }

    if (intent === "toggle") {
      const enabled = String(formData.get("enabled") ?? "") === "true";
      const source = await access.client.updateSource(sourceId, { enabled });
      await appendEvent(principal, {
        entityType: "export_source",
        entityId: sourceId,
        event: enabled ? "export_source.enabled" : "export_source.disabled",
        detail: { name: source.name, actor },
      });
      return {
        ok: true,
        message: enabled
          ? `${source.name} is on.`
          : `${source.name} is off. It will not run until it is turned on again.`,
      } satisfies ActionResult;
    }

    if (intent === "delete") {
      await access.client.deleteSource(sourceId);
      await appendEvent(principal, {
        entityType: "export_source",
        entityId: sourceId,
        event: "export_source.deleted",
        detail: { actor },
      });
      return {
        ok: true,
        message: "The source was deleted in the export portal.",
      } satisfies ActionResult;
    }

    return { ok: false, message: "Unknown action." } satisfies ActionResult;
  } catch (error) {
    return {
      ok: false,
      message: portalFailure(error).message,
    } satisfies ActionResult;
  }
};

export default function Sources() {
  const { shell, portal, awaitingReview, note } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const result = fetcher.data;
  const sources = portal.kind === "read" ? portal.data : [];
  const headline = summarizeSources(sources);
  // A run just asked for may not be listed by the portal's first answer;
  // the page watches closely until it is, then as long as it runs.
  const [watching, watch] = useWatchWindow(30_000, headline.active > 0);
  useLiveRevalidation({ active: headline.active > 0 || watching });

  const [pendingDelete, setPendingDelete] = useState<SourceSummary | null>(
    null,
  );

  useEffect(() => {
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
    if (result.started) watch();
  }, [result]);

  const submit = (body: Record<string, string>) =>
    void fetcher.submit(body, { method: "post" });
  const busy = fetcher.state !== "idle";
  const busyWith = (intent: string, sourceId: string) =>
    busy &&
    fetcher.formData?.get("intent") === intent &&
    fetcher.formData?.get("sourceId") === sourceId;

  return (
    <s-page heading="Sources" inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>

      <s-button
        slot="primary-action"
        variant="primary"
        href={SOURCE_ROUTES.new}
        {...(portal.kind !== "read" ? { disabled: true } : {})}
      >
        New source
      </s-button>
      {/*
       * The connection in the header, the way Products and Locations put their
       * settings there: this page is what is happening; the connection page is
       * what makes it possible.
       */}
      <s-button
        slot="secondary-actions"
        icon="question-circle"
        command="--show"
        commandFor={HELP_MODAL_ID}
      >
        Help
      </s-button>

      <s-modal id={HELP_MODAL_ID} heading="About sources">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            A source is one product source the export portal pushes into this
            store: a catalogue export or a brand feed, stocked at one location,
            with its own settings for stock, prices and products. The portal
            does the pushing; this page is where the store configures it and
            sees how it is going, without opening the portal.
          </s-paragraph>
          <s-paragraph>
            Everything here is read from the portal as the page opens. Nothing
            about a source is stored in this app except the API key that
            connects the two.
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

      <ConfirmModal
        id={DELETE_MODAL_ID}
        heading={
          pendingDelete ? `Delete ${pendingDelete.name}?` : "Delete the source?"
        }
        confirmLabel="Delete source"
        onConfirm={() => {
          if (pendingDelete)
            submit({ intent: "delete", sourceId: pendingDelete.id });
          setPendingDelete(null);
        }}
      >
        <s-paragraph>
          The source and its settings are removed from the export portal.
          Products and stock it has already written to the store are not
          touched.
        </s-paragraph>
      </ConfirmModal>

      <SourcesNav current="sources" awaitingReview={awaitingReview} />

      <s-stack direction="block" gap="base">
        {note && !(result && !result.ok) ? (
          <s-banner tone="success">
            <s-paragraph>{note}</s-paragraph>
          </s-banner>
        ) : null}

        {awaitingReview > 0 ? (
          <s-banner
            tone="info"
            heading={
              awaitingReview === 1
                ? "1 new product is waiting for review"
                : `${awaitingReview.toLocaleString("en")} new products are waiting for review`
            }
          >
            <s-paragraph>
              They are drafts in Shopify and not on sale until someone approves
              them.
            </s-paragraph>
            <s-button slot="secondary-actions" href={SOURCE_ROUTES.review()}>
              Review them
            </s-button>
          </s-banner>
        ) : null}

        {result && !result.ok ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        {portal.kind === "not_configured" ? (
          <s-banner
            tone="warning"
            heading="The export portal is not configured on this server"
          >
            <s-paragraph>
              Set EXPORT_PORTAL_URL in the server environment to the
              portal&apos;s address. Until then this area cannot show anything.
            </s-paragraph>
          </s-banner>
        ) : null}

        {portal.kind === "not_connected" ? (
          <s-section heading="Connect the export portal">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Generate an API key for this store in the export portal&apos;s
                admin and paste it here. The store&apos;s sources then appear on
                this page and can be configured and run from it.
              </s-paragraph>
              <s-stack direction="inline">
                <s-button variant="primary" href={SOURCE_ROUTES.connection}>
                  Connect
                </s-button>
              </s-stack>
            </s-stack>
          </s-section>
        ) : null}

        {portal.kind === "unavailable" ? (
          <s-banner
            tone={
              portal.failure === "server" || portal.failure === "unavailable"
                ? "warning"
                : "critical"
            }
            heading="The sources could not be read"
          >
            <s-stack direction="block" gap="base">
              <s-paragraph>{portal.message}</s-paragraph>
              <s-stack direction="inline" gap="base">
                <s-button
                  onClick={() => void revalidator.revalidate()}
                  {...(revalidator.state !== "idle"
                    ? { disabled: true, loading: true }
                    : {})}
                >
                  Try again
                </s-button>
                {portal.failure === "unauthorized" ||
                portal.failure === "forbidden" ? (
                  <s-button href={SOURCE_ROUTES.connection}>
                    Open the connection
                  </s-button>
                ) : null}
              </s-stack>
            </s-stack>
          </s-banner>
        ) : null}

        {/*
         * An empty portal and an empty search are different problems: the
         * first explains what will appear here, the table explains the
         * second itself.
         */}
        {portal.kind === "read" && sources.length === 0 ? (
          <s-section>
            <s-box paddingBlock="large-100">
              <s-stack direction="block" gap="base" alignItems="center">
                <s-stack direction="block" gap="small-300" alignItems="center">
                  <s-heading>No sources yet</s-heading>
                  <s-text color="subdued">
                    {shell.connection.tenantName
                      ? `Connect a catalogue export or a brand feed to start pushing products into the store. The export portal has none for ${shell.connection.tenantName} yet.`
                      : "Connect a catalogue export or a brand feed to start pushing products into the store."}
                  </s-text>
                </s-stack>
                <s-button variant="primary" href={SOURCE_ROUTES.new}>
                  New source
                </s-button>
              </s-stack>
            </s-box>
          </s-section>
        ) : null}

        {portal.kind === "read" && sources.length > 0 ? (
          <>
            <SourcesSummary headline={headline} />

            <SourcesTable
              sources={sources}
              refreshing={revalidator.state !== "idle"}
              actions={{
                run: (source) => submit({ intent: "run", sourceId: source.id }),
                toggle: (source) =>
                  submit({
                    intent: "toggle",
                    sourceId: source.id,
                    enabled: source.enabled ? "false" : "true",
                  }),
                askDelete: setPendingDelete,
                deleteModalId: DELETE_MODAL_ID,
                busyWith,
                busy,
              }}
            />

            {shell.connection.tenantName ? (
              <s-text color="subdued">
                {`Read from the export portal as ${shell.connection.tenantName}.`}
              </s-text>
            ) : null}
          </>
        ) : null}
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
