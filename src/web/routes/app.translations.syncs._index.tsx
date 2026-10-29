import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  useLoaderData,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { listSyncs } from "~/adapters/db/repositories/translations.server";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { SYNC_MODE_LABEL, type SyncMode } from "~/domain/translations/types";
import { ProcessHeader } from "~/web/components/process-header";
import { TranslationsNav } from "~/web/components/translations-nav";
import { formatDateTime } from "~/web/lib/datetime";
import { principalFromSession } from "~/web/lib/principal.server";
import {
  syncName,
  SYNC_STATUS_LABEL,
  TRANSLATION_ROUTES,
} from "~/web/lib/translations";
import { useLiveRevalidation } from "~/web/lib/live";

/**
 * Syncs (docs/translations.md § Syncs): every translation run, newest first,
 * with what it did. A running one moves as the page polls.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const syncs = await listSyncs(principal, 100);
  return {
    syncs: syncs.map((sync) => ({
      id: sync.id,
      kind: sync.kind,
      mode: sync.mode,
      status: sync.status,
      sourceLocale: sync.sourceLocale,
      targetLocales: sync.targetLocales,
      resourceTypes: sync.resourceTypes.length,
      name: syncName({
        kind: sync.kind,
        requestedBy: sync.requestedBy,
        resources: sync.resourceIds.length,
      }),
      totalResources: sync.totalResources,
      doneResources: sync.doneResources,
      translatedFields: sync.translatedFields,
      copiedFields: sync.copiedFields,
      skippedFields: sync.skippedFields,
      failedFields: sync.failedFields,
      requestedBy: sync.requestedBy,
      createdAt: sync.createdAt.toISOString(),
      finishedAt: sync.finishedAt?.toISOString() ?? null,
    })),
  };
};

export default function Syncs() {
  const { syncs } = useLoaderData<typeof loader>();
  const active = syncs.some(
    (sync) => sync.status === "queued" || sync.status === "running",
  );
  useLiveRevalidation({ active: active, idleEveryMs: null });
  const latestFinished = syncs.find((sync) => sync.finishedAt !== null);
  // Syncs the app starts itself (changed products, automatic translation)
  // make the process automatic; otherwise it runs when a person asks.
  const automatic = syncs.some(
    (sync) =>
      sync.kind === "automatic" ||
      (sync.kind === "resource" && sync.requestedBy === null),
  );

  return (
    <s-page heading="Syncs" inlineSize="large">
      <s-link slot="breadcrumb-actions" href={TRANSLATION_ROUTES.languages}>
        Translations
      </s-link>
      <s-button
        slot="primary-action"
        variant="primary"
        href={TRANSLATION_ROUTES.translate}
      >
        Translate store
      </s-button>

      <s-stack direction="block" gap="large">
        <TranslationsNav current="syncs" />

        {syncs.length > 0 ? (
          <ProcessHeader
            health={syncs[0]!.status === "failed" ? "needs_attention" : "ok"}
            lastRun={
              latestFinished
                ? {
                    at: latestFinished.finishedAt!,
                    outcome: latestFinished.status,
                  }
                : null
            }
            mode={automatic ? "automatic" : "manual"}
            running={active}
            attention={{
              href: TRANSLATION_ROUTES.sync(syncs[0]!.id),
              label: "Open the sync",
            }}
          />
        ) : null}

        <s-section>
          {syncs.length === 0 ? (
            <s-text color="subdued">
              No syncs yet. Translate the store, a language or a single resource
              and it appears here.
            </s-text>
          ) : (
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">Sync</s-table-header>
                <s-table-header listSlot="secondary">Status</s-table-header>
                <s-table-header>Languages</s-table-header>
                <s-table-header format="numeric">Progress</s-table-header>
                <s-table-header>Result</s-table-header>
                <s-table-header listSlot="kicker">Started</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {syncs.map((sync) => (
                  <s-table-row key={sync.id} clickDelegate={`open-${sync.id}`}>
                    <s-table-cell>
                      <s-stack direction="block" gap="small-500">
                        <s-link
                          id={`open-${sync.id}`}
                          href={TRANSLATION_ROUTES.sync(sync.id)}
                        >
                          {sync.name}
                        </s-link>
                        <s-text color="subdued">
                          {`${SYNC_MODE_LABEL[sync.mode as SyncMode] ?? sync.mode}${sync.requestedBy ? ` · ${sync.requestedBy}` : ""}`}
                        </s-text>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge
                        {...(sync.status === "failed"
                          ? { tone: "critical" as const }
                          : sync.status === "running" ||
                              sync.status === "queued"
                            ? { tone: "info" as const }
                            : {})}
                      >
                        {SYNC_STATUS_LABEL[sync.status] ?? sync.status}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      <s-text>{sync.targetLocales.join(", ")}</s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <s-text>
                        {sync.totalResources > 0
                          ? `${sync.doneResources.toLocaleString("en")} / ${sync.totalResources.toLocaleString("en")}`
                          : `${sync.doneResources.toLocaleString("en")} resources`}
                      </s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <s-text>
                        {[
                          `${sync.translatedFields.toLocaleString("en")} translated`,
                          sync.copiedFields > 0
                            ? `${sync.copiedFields} copied`
                            : null,
                          sync.failedFields > 0
                            ? `${sync.failedFields} failed`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(", ")}
                      </s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <s-text color="subdued">
                        {formatDateTime(sync.createdAt)}
                      </s-text>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
