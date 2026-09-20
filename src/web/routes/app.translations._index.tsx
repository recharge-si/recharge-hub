import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect } from "react";
import {
  useFetcher,
  useLoaderData,
  useRevalidator,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";

import { authenticate } from "~/adapters/shopify/shopify.server";
import { requestCoverageRefresh } from "~/adapters/translations/syncs.server";
import { TranslationsNav } from "~/web/components/translations-nav";
import { formatDateTime } from "~/web/lib/datetime";
import { principalFromSession } from "~/web/lib/principal.server";
import {
  TRANSLATION_ROUTES,
  aiStateLabel,
  formatPercent,
  shopifyStateLabel,
} from "~/web/lib/translations";
import { loadLanguagesOverview } from "~/web/lib/translations.server";

/**
 * Languages (docs/translations.md § Screens): every locale the store has,
 * what Shopify says about it, what the AI does for it, and how translated
 * it is.
 *
 * Two columns, two authorities. "Shopify" is read from `shopLocales` on
 * every load and is never stored; "AI translation" is this app's own
 * setting. Coverage is a counted cache with the time it was counted.
 */
const HELP_MODAL_ID = "about-translations";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  return loadLanguagesOverview(principal, admin);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "refresh-coverage") {
    const jobId = await requestCoverageRefresh(principal, 60);
    return {
      ok: true,
      message: jobId
        ? "Counting translations across the store. This takes a few minutes for a large catalogue."
        : "Translations are already being counted.",
    };
  }
  return { ok: false, message: "Unknown action." };
};

function useLivePolling(active: boolean) {
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") void revalidator.revalidate();
    }, 5000);
    return () => clearInterval(timer);
  }, [active, revalidator]);
}

export default function Languages() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data;
  useLivePolling(data.kind === "read" && data.activeSyncs > 0);

  useEffect(() => {
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [result]);

  return (
    <s-page heading="Translations">
      <s-link slot="breadcrumb-actions" href="/app">
        Home
      </s-link>

      <s-button
        slot="primary-action"
        variant="primary"
        href={TRANSLATION_ROUTES.add}
        {...(data.kind !== "read" ? { disabled: true } : {})}
      >
        Add language
      </s-button>
      <s-button
        slot="secondary-actions"
        href={TRANSLATION_ROUTES.translate}
        {...(data.kind !== "read" || !data.ai.configured
          ? { disabled: true }
          : {})}
      >
        Translate store
      </s-button>
      <s-button
        slot="secondary-actions"
        icon="question-circle"
        command="--show"
        commandFor={HELP_MODAL_ID}
      >
        Help
      </s-button>

      <s-modal id={HELP_MODAL_ID} heading="About translations">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Shopify holds the store&apos;s languages and every translation. This
            app manages them from here: add a language, publish it, translate
            the store with AI, edit a translation by hand, and see what the AI
            cost. Nothing is stored outside Shopify except the AI&apos;s
            settings, your glossary and the record of what it wrote.
          </s-paragraph>
          <s-paragraph>
            &quot;Shopify&quot; and &quot;AI translation&quot; are separate
            answers. A language can be published with the AI off, or translated
            by the AI and still unpublished until you are happy with it.
          </s-paragraph>
          <s-paragraph>
            A translation you write or correct yourself is protected: the AI
            does not replace it on a later run unless you tell the language to
            allow that.
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

      <s-stack direction="block" gap="large">
        <TranslationsNav current="languages" />

        {result && !result.ok ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        {data.kind === "unavailable" ? (
          <s-banner
            tone="warning"
            heading="Languages could not be read from Shopify"
          >
            <s-paragraph>{data.reason}</s-paragraph>
          </s-banner>
        ) : null}

        {!data.ai.configured ? (
          <s-banner
            tone="info"
            heading="AI translation is not configured on this server"
          >
            <s-paragraph>
              Languages can still be added, published and removed, and
              translations edited by hand. Set OPENAI_API_KEY in the server
              environment to translate with AI.
            </s-paragraph>
          </s-banner>
        ) : null}

        {data.kind === "read" ? (
          <s-section heading="Languages">
            <s-stack direction="block" gap="base">
              {data.rows.length === 0 ? (
                <s-text color="subdued">Shopify reports no languages.</s-text>
              ) : (
                <s-table variant="auto">
                  <s-table-header-row>
                    <s-table-header listSlot="primary">Language</s-table-header>
                    <s-table-header listSlot="secondary">
                      Shopify
                    </s-table-header>
                    <s-table-header>AI translation</s-table-header>
                    <s-table-header format="numeric">Coverage</s-table-header>
                    <s-table-header>Needs work</s-table-header>
                    <s-table-header>Last sync</s-table-header>
                  </s-table-header-row>
                  <s-table-body>
                    {data.rows.map((row) => (
                      <s-table-row
                        key={row.locale}
                        clickDelegate={`open-${row.locale}`}
                      >
                        <s-table-cell>
                          <s-stack direction="block" gap="small-500">
                            <s-link
                              id={`open-${row.locale}`}
                              href={TRANSLATION_ROUTES.language(row.locale)}
                            >
                              {row.name}
                            </s-link>
                            <s-text color="subdued">
                              {row.locale}
                              {row.markets.length > 0
                                ? ` · ${row.markets.join(", ")}`
                                : ""}
                            </s-text>
                          </s-stack>
                        </s-table-cell>
                        <s-table-cell>
                          <s-badge
                            {...(row.published || row.primary
                              ? {}
                              : { tone: "warning" as const })}
                          >
                            {shopifyStateLabel(row)}
                          </s-badge>
                        </s-table-cell>
                        <s-table-cell>
                          <s-text>{aiStateLabel(row, row.settings)}</s-text>
                        </s-table-cell>
                        <s-table-cell>
                          <s-text>{formatPercent(row.coverage)}</s-text>
                        </s-table-cell>
                        <s-table-cell>
                          {row.primary ? (
                            <s-text color="subdued">—</s-text>
                          ) : row.missing === 0 && row.outdated === 0 ? (
                            <s-text color="subdued">Nothing</s-text>
                          ) : (
                            <s-text>
                              {[
                                row.missing > 0
                                  ? `${row.missing.toLocaleString("en")} missing`
                                  : null,
                                row.outdated > 0
                                  ? `${row.outdated.toLocaleString("en")} outdated`
                                  : null,
                              ]
                                .filter(Boolean)
                                .join(", ")}
                            </s-text>
                          )}
                        </s-table-cell>
                        <s-table-cell>
                          {row.syncing ? (
                            <s-badge tone="info">Translating now</s-badge>
                          ) : row.primary ? (
                            <s-text color="subdued">—</s-text>
                          ) : row.lastSuccessfulSyncAt ? (
                            <s-text color="subdued">
                              {formatDateTime(row.lastSuccessfulSyncAt)}
                            </s-text>
                          ) : (
                            <s-text color="subdued">Never</s-text>
                          )}
                        </s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              )}

              <s-grid
                gridTemplateColumns="@container (inline-size <= 560px) 1fr, 1fr auto"
                gap="base"
                alignItems="center"
              >
                <s-text color="subdued">
                  {data.coverageAt
                    ? `Coverage counted ${formatDateTime(data.coverageAt)} across every translatable field. It is recounted after each sync and nightly.`
                    : "Coverage has not been counted yet. Count it once to see what each language is missing."}
                </s-text>
                <s-button
                  type="button"
                  onClick={() =>
                    fetcher.submit(
                      { intent: "refresh-coverage" },
                      { method: "post" },
                    )
                  }
                  {...(fetcher.state !== "idle"
                    ? { disabled: true, loading: true }
                    : {})}
                >
                  {data.coverageAt ? "Count again" : "Count coverage"}
                </s-button>
              </s-grid>
            </s-stack>
          </s-section>
        ) : null}

        {data.kind === "read" && data.primary ? (
          <s-section heading="Source language">
            <s-stack direction="block" gap="small-300">
              <s-text>
                {`${data.primary.name} (${data.primary.locale}) is the store's default language in Shopify and the language the AI translates from.`}
              </s-text>
              <s-text color="subdued">
                A page, product or article written in another language can name
                its own source in the editor; it is then translated directly
                from that language, never through the default.
              </s-text>
            </s-stack>
          </s-section>
        ) : null}
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
