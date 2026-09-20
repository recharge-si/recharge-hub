import { boundary } from "@shopify/shopify-app-react-router/server";
import { useMemo, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";
import { z } from "zod";

import { isConfigured } from "~/adapters/ai/openai.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import { saveLanguageSettings } from "~/adapters/db/repositories/translations.server";
import {
  enableShopLocale,
  listAvailableLocales,
  listMarkets,
  listShopLocales,
  updateShopLocale,
} from "~/adapters/shopify/locales";
import { authenticate } from "~/adapters/shopify/shopify.server";
import { isLocaleCode } from "~/adapters/shopify/translations";
import {
  requestCoverageRefresh,
  startSync,
} from "~/adapters/translations/syncs.server";
import {
  ALL_CONTENT_GROUPS,
  typesForGroups,
} from "~/domain/translations/types";
import { TranslationsNav } from "~/web/components/translations-nav";
import {
  actorFromSession,
  principalFromSession,
} from "~/web/lib/principal.server";
import { redirectWithin } from "~/web/lib/redirects";
import { TRANSLATION_ROUTES } from "~/web/lib/translations";

/**
 * Add language (docs/translations.md § Add language): choose one of the
 * locales Shopify supports, enable it in Shopify, say what the AI should do
 * for it, and optionally publish it and translate what exists.
 *
 * The locale is created by `shopLocaleEnable`; nothing is written here until
 * Shopify has answered. Our settings row follows, and an initial sync if
 * asked. Publishing is a separate Shopify call, so a language whose
 * translation has not started is never visible to shoppers by accident.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const [available, enabled, markets] = await Promise.all([
    listAvailableLocales(admin),
    listShopLocales(admin),
    listMarkets(admin),
  ]);
  const taken = new Set(
    enabled.kind === "read"
      ? enabled.locales.map((locale) => locale.locale)
      : [],
  );
  return {
    available: available.filter((locale) => !taken.has(locale.isoCode)),
    presences:
      markets.kind === "read"
        ? markets.markets.flatMap((market) =>
            market.presences.map((presence) => ({
              id: presence.id,
              market: market.name,
              label: presence.label,
              defaultLocale: presence.defaultLocale,
            })),
          )
        : [],
    aiConfigured: isConfigured(),
  };
};

const formSchema = z.object({
  locale: z.string().trim().min(2),
  publish: z.boolean(),
  presenceIds: z.array(z.string()),
  aiEnabled: z.boolean(),
  autoTranslateNew: z.boolean(),
  autoUpdateOutdated: z.boolean(),
  initial: z.enum(["none", "missing", "missing_outdated"]),
});

type SaveResult = { ok: false; message: string };

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<SaveResult> => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const actor = actorFromSession(session);

  let json: unknown;
  try {
    json = JSON.parse(String((await request.formData()).get("form") ?? ""));
  } catch {
    return {
      ok: false,
      message: "The form could not be read. Reload the page and try again.",
    };
  }
  const parsed = formSchema.safeParse(json);
  if (!parsed.success)
    return {
      ok: false,
      message: "The form could not be read. Reload the page and try again.",
    };
  const form = parsed.data;
  if (!isLocaleCode(form.locale))
    return { ok: false, message: "Choose a language from the list." };

  const enabled = await enableShopLocale(admin, form.locale, form.presenceIds);
  if (enabled.kind === "rejected")
    return {
      ok: false,
      message: `Shopify did not add the language: ${enabled.messages.join("; ")}`,
    };

  let publishFailed: string | null = null;
  if (form.publish) {
    const published = await updateShopLocale(admin, form.locale, {
      published: true,
    });
    if (published.kind === "rejected")
      publishFailed = published.messages.join("; ");
  }

  await saveLanguageSettings(principal, {
    locale: form.locale,
    aiEnabled: form.aiEnabled,
    autoTranslateNew: form.aiEnabled && form.autoTranslateNew,
    autoUpdateOutdated: form.aiEnabled && form.autoUpdateOutdated,
    contentScope: [...ALL_CONTENT_GROUPS],
    overwritePolicy: "update_ai_managed",
  });
  await appendEvent(principal, {
    entityType: "translation_language",
    entityId: form.locale,
    event: "translation_language.added",
    detail: {
      published: form.publish && !publishFailed,
      presences: form.presenceIds.length,
      aiEnabled: form.aiEnabled,
      by: actor,
    },
  });
  await requestCoverageRefresh(principal, 60);

  if (form.initial !== "none" && form.aiEnabled && isConfigured()) {
    const sync = await startSync(principal, {
      kind: "language",
      mode: form.initial,
      // The sync reads the store's primary locale from Shopify itself.
      sourceLocale: "",
      targetLocales: [form.locale],
      resourceTypes: typesForGroups([...ALL_CONTENT_GROUPS]),
      requestedBy: actor,
    });
    throw redirectWithin(request, TRANSLATION_ROUTES.sync(sync.id));
  }

  if (publishFailed) {
    // The language exists and its settings are saved; only publishing failed.
    // The language page says so and offers the button again.
    throw redirectWithin(
      request,
      `${TRANSLATION_ROUTES.language(form.locale)}?notice=${encodeURIComponent(`Added, but not published: ${publishFailed}`)}`,
    );
  }
  throw redirectWithin(request, TRANSLATION_ROUTES.language(form.locale));
};

const SHOWN = 12;

export default function AddLanguage() {
  const { available, presences, aiConfigured } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [search, setSearch] = useState("");
  const [locale, setLocale] = useState<string | null>(null);
  const [publish, setPublish] = useState(false);
  const [presenceIds, setPresenceIds] = useState<string[]>([]);
  const [aiEnabled, setAiEnabled] = useState(aiConfigured);
  const [autoNew, setAutoNew] = useState(true);
  const [autoOutdated, setAutoOutdated] = useState(true);
  const [initial, setInitial] = useState<
    "none" | "missing" | "missing_outdated"
  >("none");

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = needle
      ? available.filter(
          (item) =>
            item.name.toLowerCase().includes(needle) ||
            item.isoCode.toLowerCase().includes(needle),
        )
      : available;
    return list;
  }, [available, search]);
  const chosen = available.find((item) => item.isoCode === locale) ?? null;
  const busy = fetcher.state !== "idle";

  const submit = () => {
    if (!locale) return;
    fetcher.submit(
      {
        form: JSON.stringify({
          locale,
          publish,
          presenceIds,
          aiEnabled,
          autoTranslateNew: autoNew,
          autoUpdateOutdated: autoOutdated,
          initial: aiEnabled ? initial : "none",
        }),
      },
      { method: "post" },
    );
  };

  return (
    <s-page heading="Add language" inlineSize="base">
      <s-link slot="breadcrumb-actions" href={TRANSLATION_ROUTES.languages}>
        Translations
      </s-link>
      <s-button
        slot="primary-action"
        variant="primary"
        type="button"
        onClick={submit}
        {...(!locale || busy ? { disabled: true } : {})}
        {...(busy ? { loading: true } : {})}
      >
        Add language
      </s-button>

      <s-stack direction="block" gap="large">
        <TranslationsNav current="languages" />

        {fetcher.data && !fetcher.data.ok ? (
          <s-banner tone="critical" heading="The language was not added">
            <s-paragraph>{fetcher.data.message}</s-paragraph>
          </s-banner>
        ) : null}

        <s-section heading="1. Language">
          <s-stack direction="block" gap="base">
            <s-text-field
              label="Find a language"
              labelAccessibilityVisibility="exclusive"
              placeholder="German, de, Slovenian…"
              value={search}
              onInput={(event) => setSearch(event.currentTarget.value)}
              onChange={(event) => setSearch(event.currentTarget.value)}
              {...(busy ? { disabled: true } : {})}
            />
            {chosen ? (
              <s-box padding="base" border="base" borderRadius="base">
                <s-grid
                  gridTemplateColumns="1fr auto"
                  gap="base"
                  alignItems="center"
                >
                  <s-stack direction="block" gap="small-500">
                    <s-text type="strong">{chosen.name}</s-text>
                    <s-text color="subdued">{chosen.isoCode}</s-text>
                  </s-stack>
                  <s-button type="button" onClick={() => setLocale(null)}>
                    Change
                  </s-button>
                </s-grid>
              </s-box>
            ) : (
              <s-stack direction="block" gap="small-300">
                {matches.slice(0, SHOWN).map((item) => (
                  <s-clickable
                    key={item.isoCode}
                    border="base"
                    borderRadius="base"
                    padding="small-200"
                    onClick={() => setLocale(item.isoCode)}
                  >
                    <s-grid
                      gridTemplateColumns="1fr auto"
                      gap="base"
                      alignItems="center"
                    >
                      <s-text>{item.name}</s-text>
                      <s-text color="subdued">{item.isoCode}</s-text>
                    </s-grid>
                  </s-clickable>
                ))}
                {matches.length > SHOWN ? (
                  <s-text color="subdued">
                    {`${matches.length - SHOWN} more. Keep typing to narrow the list.`}
                  </s-text>
                ) : null}
                {matches.length === 0 ? (
                  <s-text color="subdued">
                    No language matches that. Shopify lists the languages a
                    store can have.
                  </s-text>
                ) : null}
              </s-stack>
            )}
          </s-stack>
        </s-section>

        <s-section heading="2. In Shopify">
          <s-stack direction="block" gap="base">
            <s-stack direction="block" gap="small-400">
              <s-checkbox
                label="Publish now"
                checked={publish}
                onChange={(event) => setPublish(event.currentTarget.checked)}
                {...(busy ? { disabled: true } : {})}
              />
              <s-text color="subdued">
                A published language is visible to shoppers. Shopify adds a
                language unpublished; leave this off to translate first and
                publish from the language&apos;s page when it reads well.
              </s-text>
            </s-stack>
            {presences.length > 0 ? (
              <s-stack direction="block" gap="small-400">
                <s-text type="strong">Available in</s-text>
                <s-text color="subdued">
                  Which markets serve this language. A market not ticked here
                  keeps its own languages; this can be changed later.
                </s-text>
                {presences.map((presence) => (
                  <s-checkbox
                    key={presence.id}
                    label={`${presence.market} · ${presence.label}`}
                    details={`Default language ${presence.defaultLocale}`}
                    checked={presenceIds.includes(presence.id)}
                    onChange={(event) =>
                      setPresenceIds((now) =>
                        event.currentTarget.checked
                          ? [...now, presence.id]
                          : now.filter((id) => id !== presence.id),
                      )
                    }
                    {...(busy ? { disabled: true } : {})}
                  />
                ))}
              </s-stack>
            ) : null}
          </s-stack>
        </s-section>

        <s-section heading="3. AI translation">
          <s-stack direction="block" gap="base">
            {!aiConfigured ? (
              <s-text color="subdued">
                AI translation is not configured on this server. The language
                can still be added and translated by hand.
              </s-text>
            ) : null}
            <s-checkbox
              label="Enable AI translation"
              checked={aiEnabled}
              onChange={(event) => setAiEnabled(event.currentTarget.checked)}
              {...(busy || !aiConfigured ? { disabled: true } : {})}
            />
            {aiEnabled ? (
              <s-stack direction="block" gap="small-300">
                <s-checkbox
                  label="Translate new content automatically"
                  checked={autoNew}
                  onChange={(event) => setAutoNew(event.currentTarget.checked)}
                  {...(busy ? { disabled: true } : {})}
                />
                <s-checkbox
                  label="Update outdated translations automatically"
                  details="Only translations the AI wrote itself. Anything a person wrote or corrected is left alone."
                  checked={autoOutdated}
                  onChange={(event) =>
                    setAutoOutdated(event.currentTarget.checked)
                  }
                  {...(busy ? { disabled: true } : {})}
                />
              </s-stack>
            ) : null}
          </s-stack>
        </s-section>

        {aiEnabled ? (
          <s-section heading="4. Existing content">
            <s-choice-list
              label="Translate what the store already has"
              labelAccessibilityVisibility="exclusive"
              name="initial"
              values={[initial]}
              onChange={(event) => {
                const value = event.currentTarget.values[0];
                if (
                  value === "none" ||
                  value === "missing" ||
                  value === "missing_outdated"
                )
                  setInitial(value);
              }}
              {...(busy ? { disabled: true } : {})}
            >
              <s-choice value="none">Not yet</s-choice>
              <s-choice value="missing">Translate missing content</s-choice>
              <s-choice value="missing_outdated">
                Translate missing and outdated content
              </s-choice>
            </s-choice-list>
            <s-text color="subdued">
              Starts a sync you can watch and cancel. Its estimate and cost are
              shown on the sync&apos;s page and on AI usage.
            </s-text>
          </s-section>
        ) : null}
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
