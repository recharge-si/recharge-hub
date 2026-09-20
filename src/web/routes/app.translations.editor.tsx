import { boundary } from "@shopify/shopify-app-react-router/server";
import { useCallback, useEffect, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "react-router";
import { z } from "zod";

import { detectLanguage, isConfigured } from "~/adapters/ai/openai.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  forgetOwnership,
  getSourceOverride,
  listOwnership,
  recordOwnership,
  setSourceOverride,
  recordDetectedSource,
} from "~/adapters/db/repositories/translations.server";
import { listShopLocales } from "~/adapters/shopify/locales";
import { authenticate } from "~/adapters/shopify/shopify.server";
import {
  isLocaleCode,
  isSearchable,
  readTranslatableResources,
  readTranslatableResourcesByIds,
  registerTranslations,
  removeTranslations,
  resourceTitle,
  searchResourceIds,
  type TranslatableResource,
} from "~/adapters/shopify/translations";
import { hashValue } from "~/adapters/translations/engine.server";
import { translateResourceNow } from "~/adapters/translations/inline.server";
import { classifyField, isTranslatableField } from "~/domain/translations/plan";
import {
  ALL_RESOURCE_TYPES,
  FIELD_STATE_LABEL,
  RESOURCE_TYPE_LABEL,
  fieldLabel,
  isResourceType,
  type FieldState,
  type OwnershipRecord,
  type ResourceType,
} from "~/domain/translations/types";
import { Dropdown } from "~/web/components/dropdown";
import { TranslationsNav } from "~/web/components/translations-nav";
import {
  actorFromSession,
  principalFromSession,
} from "~/web/lib/principal.server";
import { redirectWithin } from "~/web/lib/redirects";
import {
  TRANSLATION_ROUTES,
  describeResourceId,
  localeLabel,
} from "~/web/lib/translations";
import { useResetWhenSaved, useSaveBar } from "~/web/lib/use-save-bar";

/**
 * The translation editor (docs/translations.md § Editor): browse what
 * Shopify holds for one language and one kind of content, open a resource,
 * see each field's source beside its translation and its state, and save.
 *
 * Saving is `translationsRegister` — the translation lands in Shopify and
 * nowhere else — and records the field as a person's work, which the AI
 * then leaves alone. An emptied field is `translationsRemove`. The source
 * language a resource is written in is shown and can be changed here;
 * detection only suggests.
 *
 * The list is a page of Shopify's `translatableResources`, filtered in this
 * request: Shopify offers no query on that connection, so a search goes to
 * the resource's own connection by title first.
 */
const SAVE_BAR_ID = "translation-editor-save-bar";
const PAGE = 25;

const STATUS_FILTERS = ["all", "missing", "outdated", "manual", "ai"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  all: "Everything",
  missing: "Missing",
  outdated: "Outdated",
  manual: "Edited by a person",
  ai: "Written by AI",
};

function editorUrl(params: {
  locale: string;
  type: ResourceType;
  status: StatusFilter;
  q: string;
  after?: string | null;
  resource?: string | null;
}): string {
  const search = new URLSearchParams();
  search.set("locale", params.locale);
  search.set("type", params.type);
  if (params.status !== "all") search.set("status", params.status);
  if (params.q) search.set("q", params.q);
  if (params.after) search.set("after", params.after);
  if (params.resource) search.set("resource", params.resource);
  return `${TRANSLATION_ROUTES.editor}?${search.toString()}`;
}

interface StateCounts {
  missing: number;
  outdated: number;
  manual: number;
  ai: number;
  existing: number;
}

function countStates(
  resource: TranslatableResource,
  locale: string,
  ownership: readonly OwnershipRecord[],
): StateCounts {
  const counts: StateCounts = {
    missing: 0,
    outdated: 0,
    manual: 0,
    ai: 0,
    existing: 0,
  };
  const translations = new Map(
    (resource.translations.get(locale) ?? []).map((t) => [t.key, t]),
  );
  const records = new Map(
    ownership.filter((r) => r.locale === locale).map((r) => [r.key, r]),
  );
  for (const field of resource.fields) {
    if (!isTranslatableField(field)) continue;
    const state = classifyField(
      translations.get(field.key),
      records.get(field.key),
      hashValue,
    );
    counts[state] += 1;
  }
  return counts;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const url = new URL(request.url);

  const locales = await listShopLocales(admin);
  if (locales.kind === "unavailable")
    return { kind: "unavailable" as const, reason: locales.reason };
  const primary = locales.locales.find((l) => l.primary);
  if (!primary)
    return {
      kind: "unavailable" as const,
      reason: "Shopify reports no default language.",
    };
  const targets = locales.locales.filter((l) => !l.primary);
  if (targets.length === 0)
    return {
      kind: "no-languages" as const,
      primary: { locale: primary.locale, name: primary.name },
    };

  const wanted = url.searchParams.get("locale") ?? "";
  const locale = targets.some((l) => l.locale === wanted)
    ? wanted
    : (targets[0]?.locale ?? "");
  const typeParam = url.searchParams.get("type") ?? "PRODUCT";
  const type: ResourceType = isResourceType(typeParam) ? typeParam : "PRODUCT";
  const statusParam = url.searchParams.get("status") ?? "all";
  const status: StatusFilter = (STATUS_FILTERS as readonly string[]).includes(
    statusParam,
  )
    ? (statusParam as StatusFilter)
    : "all";
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const after = url.searchParams.get("after");
  const selectedId = url.searchParams.get("resource");

  // The list: a search by title where the type allows it, else a page.
  let page: {
    resources: TranslatableResource[];
    hasNextPage: boolean;
    endCursor: string | null;
  };
  if (q !== "" && isSearchable(type)) {
    const found = await searchResourceIds(admin, type, q, PAGE);
    const resources = await readTranslatableResourcesByIds(admin, {
      ids: found.map((row) => row.id),
      locales: [locale],
    });
    page = { resources, hasNextPage: false, endCursor: null };
  } else {
    page = await readTranslatableResources(admin, {
      type,
      first: PAGE,
      after,
      locales: [locale],
    });
  }

  const ids = page.resources.map((r) => r.resourceId);
  const needSelected = selectedId !== null && !ids.includes(selectedId);
  const [ownership, selectedRead, override] = await Promise.all([
    listOwnership(
      principal,
      needSelected && selectedId ? [...ids, selectedId] : ids,
    ),
    needSelected && selectedId
      ? readTranslatableResourcesByIds(admin, {
          ids: [selectedId],
          locales: [locale],
        })
      : Promise.resolve([] as TranslatableResource[]),
    selectedId
      ? getSourceOverride(principal, selectedId)
      : Promise.resolve(null),
  ]);

  const rows = page.resources
    .map((resource) => ({
      id: resource.resourceId,
      title: resourceTitle(resource.fields, resource.resourceId),
      states: countStates(
        resource,
        locale,
        ownership.get(resource.resourceId) ?? [],
      ),
    }))
    .filter((row) => status === "all" || row.states[status] > 0);

  const selectedResource =
    (selectedId && page.resources.find((r) => r.resourceId === selectedId)) ||
    selectedRead[0] ||
    null;
  const selectedOwnership = selectedId ? (ownership.get(selectedId) ?? []) : [];
  const selected = selectedResource
    ? (() => {
        const translations = new Map(
          (selectedResource.translations.get(locale) ?? []).map((t) => [
            t.key,
            t,
          ]),
        );
        const records = new Map(
          selectedOwnership
            .filter((r) => r.locale === locale)
            .map((r) => [r.key, r]),
        );
        return {
          id: selectedResource.resourceId,
          title: resourceTitle(
            selectedResource.fields,
            selectedResource.resourceId,
          ),
          sourceLocale: override?.sourceLocale ?? primary.locale,
          sourceIsOverride:
            override !== null && override.sourceLocale !== primary.locale,
          detectedLocale: override?.detectedLocale ?? null,
          fields: selectedResource.fields
            .filter((field) => field.digest !== null)
            .map((field) => {
              const translation = translations.get(field.key);
              return {
                key: field.key,
                label: fieldLabel(field.key),
                type: field.type,
                source: field.value,
                digest: field.digest ?? "",
                translation: translation?.value ?? "",
                state: classifyField(
                  translation,
                  records.get(field.key),
                  hashValue,
                ),
                outdated: translation?.outdated ?? false,
                updatedAt: translation?.updatedAt ?? null,
                prose: isTranslatableField(field),
              };
            }),
        };
      })()
    : null;

  return {
    kind: "read" as const,
    primary: { locale: primary.locale, name: primary.name },
    languages: targets.map((l) => ({ locale: l.locale, name: l.name })),
    allLocales: locales.locales.map((l) => ({
      locale: l.locale,
      name: l.name,
      primary: l.primary,
    })),
    locale,
    type,
    status,
    q,
    searchable: isSearchable(type),
    rows,
    filteredOut: page.resources.length - rows.length,
    hasNextPage: page.hasNextPage,
    endCursor: page.endCursor,
    selected,
    aiConfigured: isConfigured(),
  };
};

const saveSchema = z.object({
  resource: z.string().min(1),
  type: z.string(),
  locale: z.string().min(2),
  fields: z.array(
    z.object({
      key: z.string().min(1),
      value: z.string(),
      digest: z.string().min(1),
    }),
  ),
});

type ActionResult = { ok: boolean; message: string };

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionResult> => {
  const { session, admin } = await authenticate.admin(request);
  const principal = principalFromSession(session);
  const actor = actorFromSession(session);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "save") {
    let json: unknown;
    try {
      json = JSON.parse(String(formData.get("form") ?? ""));
    } catch {
      return {
        ok: false,
        message: "The form could not be read. Reload the page and try again.",
      };
    }
    const parsed = saveSchema.safeParse(json);
    if (
      !parsed.success ||
      !isLocaleCode(parsed.data.locale) ||
      !isResourceType(parsed.data.type)
    )
      return {
        ok: false,
        message: "The form could not be read. Reload the page and try again.",
      };
    const { resource, type, locale, fields } = parsed.data;

    const writes = fields.filter((field) => field.value.trim() !== "");
    const removals = fields.filter((field) => field.value.trim() === "");

    if (writes.length > 0) {
      const written = await registerTranslations(
        admin,
        resource,
        writes.map((field) => ({
          key: field.key,
          locale,
          value: field.value,
          digest: field.digest,
        })),
      );
      if (written.kind === "rejected")
        return {
          ok: false,
          message: `Shopify refused the translation: ${written.messages.join("; ")}`,
        };
      await recordOwnership(
        principal,
        writes.map((field) => ({
          resourceId: resource,
          resourceType: type,
          key: field.key,
          locale,
          owner: "manual" as const,
          valueHash: hashValue(field.value),
          sourceDigest: field.digest,
          syncId: null,
          writtenBy: actor,
        })),
        new Date(),
      );
    }
    if (removals.length > 0) {
      const removed = await removeTranslations(
        admin,
        resource,
        [locale],
        removals.map((field) => field.key),
      );
      if (removed.kind === "rejected")
        return {
          ok: false,
          message: `Shopify refused: ${removed.messages.join("; ")}`,
        };
      await forgetOwnership(
        principal,
        resource,
        locale,
        removals.map((field) => field.key),
      );
    }
    await appendEvent(principal, {
      entityType: "translation",
      entityId: resource,
      event: "translation.edited",
      detail: {
        locale,
        written: writes.length,
        removed: removals.length,
        by: actor,
      },
    });
    return {
      ok: true,
      message: `Saved to Shopify: ${writes.length} ${writes.length === 1 ? "field" : "fields"}${removals.length > 0 ? `, ${removals.length} cleared` : ""}.`,
    };
  }

  if (intent === "translate") {
    const resource = String(formData.get("resource") ?? "");
    const locale = String(formData.get("locale") ?? "");
    const typeParam = String(formData.get("type") ?? "");
    const mode = String(formData.get("mode") ?? "missing");
    if (!resource || !isLocaleCode(locale) || !isResourceType(typeParam))
      return { ok: false, message: "Unknown resource." };
    if (mode !== "missing" && mode !== "missing_outdated" && mode !== "force")
      return { ok: false, message: "Unknown action." };
    if (!isConfigured())
      return {
        ok: false,
        message: "AI translation is not configured on this server.",
      };
    const locales = await listShopLocales(admin);
    const primary =
      locales.kind === "read"
        ? locales.locales.find((l) => l.primary)
        : undefined;
    if (!primary)
      return {
        ok: false,
        message: "Languages could not be read from Shopify.",
      };

    const result = await translateResourceNow(principal, admin, {
      resourceId: resource,
      resourceType: typeParam,
      primaryLocale: primary.locale,
      targetLocales: [locale],
      mode,
      requestedBy: actor,
    });
    if (!result.found)
      return {
        ok: false,
        message: "The resource could not be read from Shopify.",
      };
    const { translated, copied, skipped, failed } = result.outcome;
    if (failed > 0)
      return {
        ok: false,
        message:
          result.outcome.items.find((item) => item.error)?.error ??
          "The translation failed.",
      };
    if (translated + copied === 0)
      return {
        ok: true,
        message: `Nothing to translate: ${skipped} fields already have a translation or are protected.`,
      };
    return {
      ok: true,
      message: `Translated ${translated} ${translated === 1 ? "field" : "fields"}${copied > 0 ? `, copied ${copied}` : ""}${skipped > 0 ? `, left ${skipped} as they were` : ""}.`,
    };
  }

  if (intent === "set-source") {
    const resource = String(formData.get("resource") ?? "");
    const typeParam = String(formData.get("type") ?? "");
    const source = String(formData.get("source") ?? "");
    if (!resource || !isResourceType(typeParam))
      return { ok: false, message: "Unknown resource." };
    if (source !== "" && !isLocaleCode(source))
      return { ok: false, message: "Unknown language." };
    await setSourceOverride(principal, {
      resourceId: resource,
      resourceType: typeParam,
      sourceLocale: source === "" ? null : source,
      setBy: actor,
    });
    await appendEvent(principal, {
      entityType: "translation",
      entityId: resource,
      event: "translation.source_changed",
      detail: { source: source || null, by: actor },
    });
    return {
      ok: true,
      message:
        source === ""
          ? "Source language: the store default."
          : `Source language set to ${source}.`,
    };
  }

  if (intent === "detect-source") {
    const resource = String(formData.get("resource") ?? "");
    const typeParam = String(formData.get("type") ?? "");
    if (!resource || !isResourceType(typeParam))
      return { ok: false, message: "Unknown resource." };
    if (!isConfigured())
      return {
        ok: false,
        message: "AI translation is not configured on this server.",
      };
    const [read, locales] = await Promise.all([
      readTranslatableResourcesByIds(admin, { ids: [resource], locales: [] }),
      listShopLocales(admin),
    ]);
    const primary =
      locales.kind === "read"
        ? locales.locales.find((l) => l.primary)
        : undefined;
    const found = read[0];
    if (!found || !primary)
      return {
        ok: false,
        message: "The resource could not be read from Shopify.",
      };
    const sample = found.fields
      .filter(isTranslatableField)
      .map((field) => field.value.replace(/<[^>]+>/g, " "))
      .join("\n")
      .slice(0, 2000);
    if (sample.trim() === "")
      return {
        ok: false,
        message: "There is no text to detect a language from.",
      };
    const detected = await detectLanguage(principal, sample, {
      resourceId: resource,
      resourceType: typeParam,
      primaryLocale: primary.locale,
    });
    if (detected.kind === "failed")
      return { ok: false, message: detected.message };
    await recordDetectedSource(principal, {
      resourceId: resource,
      resourceType: typeParam,
      detectedLocale: detected.locale,
      primaryLocale: primary.locale,
    });
    return {
      ok: true,
      message: `This looks like ${localeLabel(detected.locale)}. Nothing changed; set it as the source if that is right.`,
    };
  }

  if (intent === "open") {
    // A search or filter change: rebuild the URL so it is bookmarkable.
    const locale = String(formData.get("locale") ?? "");
    const typeParam = String(formData.get("type") ?? "PRODUCT");
    const statusParam = String(formData.get("status") ?? "all");
    throw redirectWithin(
      request,
      editorUrl({
        locale,
        type: isResourceType(typeParam) ? typeParam : "PRODUCT",
        status: (STATUS_FILTERS as readonly string[]).includes(statusParam)
          ? (statusParam as StatusFilter)
          : "all",
        q: String(formData.get("q") ?? ""),
      }),
    );
  }

  return { ok: false, message: "Unknown action." };
};

type ReadData = Extract<Awaited<ReturnType<typeof loader>>, { kind: "read" }>;

export default function Editor() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data;

  useEffect(() => {
    if (!result?.ok) return;
    if (typeof shopify !== "undefined") shopify.toast.show(result.message);
  }, [result]);

  if (data.kind === "unavailable") {
    return (
      <s-page heading="Editor">
        <s-link slot="breadcrumb-actions" href={TRANSLATION_ROUTES.languages}>
          Translations
        </s-link>
        <s-stack direction="block" gap="large">
          <TranslationsNav current="editor" />
          <s-banner
            tone="warning"
            heading="Translations could not be read from Shopify"
          >
            <s-paragraph>{data.reason}</s-paragraph>
          </s-banner>
        </s-stack>
      </s-page>
    );
  }
  if (data.kind === "no-languages") {
    return (
      <s-page heading="Editor">
        <s-link slot="breadcrumb-actions" href={TRANSLATION_ROUTES.languages}>
          Translations
        </s-link>
        <s-stack direction="block" gap="large">
          <TranslationsNav current="editor" />
          <s-section heading="Nothing to translate into yet">
            <s-stack direction="block" gap="base">
              <s-text>
                {`${data.primary.name} is the store's only language. Add a language to start translating.`}
              </s-text>
              <s-stack direction="inline">
                <s-button variant="primary" href={TRANSLATION_ROUTES.add}>
                  Add language
                </s-button>
              </s-stack>
            </s-stack>
          </s-section>
        </s-stack>
      </s-page>
    );
  }
  return <EditorPage data={data} fetcher={fetcher} result={result ?? null} />;
}

function EditorPage({
  data,
  fetcher,
  result,
}: {
  data: ReadData;
  fetcher: ReturnType<typeof useFetcher<typeof action>>;
  result: ActionResult | null;
}) {
  const busy = fetcher.state !== "idle";
  const [q, setQ] = useState(data.q);
  useResetWhenSaved(
    data.q,
    useCallback(() => setQ(data.q), [data.q]),
  );

  const open = (
    patch: Partial<{
      locale: string;
      type: ResourceType;
      status: StatusFilter;
      q: string;
    }>,
  ) =>
    fetcher.submit(
      {
        intent: "open",
        locale: patch.locale ?? data.locale,
        type: patch.type ?? data.type,
        status: patch.status ?? data.status,
        q: patch.q ?? q,
      },
      { method: "post" },
    );

  return (
    <s-page heading="Editor" inlineSize="large">
      <s-link slot="breadcrumb-actions" href={TRANSLATION_ROUTES.languages}>
        Translations
      </s-link>

      <s-stack direction="block" gap="large">
        <TranslationsNav current="editor" />

        {result && !result.ok ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        <s-section>
          <s-grid
            gridTemplateColumns="@container (inline-size <= 720px) 1fr, 1fr 1fr 1fr 2fr"
            gap="base"
            alignItems="end"
          >
            <Dropdown
              name="locale"
              label="Language"
              value={data.locale}
              options={data.languages.map((l) => ({
                value: l.locale,
                label: localeLabel(l.locale, l.name),
              }))}
              onChange={(next) => open({ locale: next })}
              disabled={busy}
            />
            <Dropdown
              name="type"
              label="Content"
              value={data.type}
              options={ALL_RESOURCE_TYPES.map((type) => ({
                value: type,
                label: RESOURCE_TYPE_LABEL[type],
              }))}
              onChange={(next) => {
                if (isResourceType(next)) open({ type: next });
              }}
              disabled={busy}
            />
            <Dropdown
              name="status"
              label="Show"
              value={data.status}
              options={STATUS_FILTERS.map((status) => ({
                value: status,
                label: STATUS_FILTER_LABEL[status],
              }))}
              onChange={(next) => {
                if ((STATUS_FILTERS as readonly string[]).includes(next))
                  open({ status: next as StatusFilter });
              }}
              disabled={busy}
            />
            <s-text-field
              label="Search by title"
              placeholder={
                data.searchable
                  ? "Patrik 5-Wave"
                  : "Not searchable for this content"
              }
              value={q}
              onInput={(event) => setQ(event.currentTarget.value)}
              onChange={(event) => {
                setQ(event.currentTarget.value);
                open({ q: event.currentTarget.value });
              }}
              {...(busy || !data.searchable ? { disabled: true } : {})}
            />
          </s-grid>
        </s-section>

        <s-grid
          gridTemplateColumns="@container (inline-size <= 900px) 1fr, minmax(260px, 1fr) 2fr"
          gap="large"
          alignItems="start"
        >
          <s-section heading={`${RESOURCE_TYPE_LABEL[data.type]}s`}>
            <s-stack direction="block" gap="small-300">
              {data.rows.length === 0 ? (
                <s-text color="subdued">
                  {data.filteredOut > 0
                    ? `None of the ${data.filteredOut} on this page match "${STATUS_FILTER_LABEL[data.status]}".`
                    : "Nothing here."}
                </s-text>
              ) : null}
              {data.rows.map((row) => (
                <s-clickable
                  key={row.id}
                  href={editorUrl({
                    locale: data.locale,
                    type: data.type,
                    status: data.status,
                    q: data.q,
                    resource: row.id,
                  })}
                  border="base"
                  borderRadius="base"
                  padding="small-200"
                  {...(data.selected?.id === row.id
                    ? { background: "subdued" as const }
                    : {})}
                >
                  <s-stack direction="block" gap="small-500">
                    <s-text type="strong">{row.title}</s-text>
                    <s-text color="subdued">
                      {summariseStates(row.states)}
                    </s-text>
                  </s-stack>
                </s-clickable>
              ))}
              {data.hasNextPage && data.endCursor ? (
                <s-stack direction="inline">
                  <s-button
                    href={editorUrl({
                      locale: data.locale,
                      type: data.type,
                      status: data.status,
                      q: data.q,
                      after: data.endCursor,
                    })}
                  >
                    Next page
                  </s-button>
                </s-stack>
              ) : null}
            </s-stack>
          </s-section>

          {data.selected ? (
            <ResourcePanel
              key={`${data.selected.id}|${data.locale}`}
              data={data}
              selected={data.selected}
              fetcher={fetcher}
              busy={busy}
            />
          ) : (
            <s-section heading="Pick something to translate">
              <s-text color="subdued">
                Choose a resource on the left. Each field shows the source text
                beside its translation, and where the translation came from.
              </s-text>
            </s-section>
          )}
        </s-grid>
      </s-stack>
    </s-page>
  );
}

function summariseStates(states: StateCounts): string {
  const parts: string[] = [];
  if (states.missing > 0) parts.push(`${states.missing} missing`);
  if (states.outdated > 0) parts.push(`${states.outdated} outdated`);
  if (states.manual > 0) parts.push(`${states.manual} by a person`);
  if (states.ai > 0) parts.push(`${states.ai} by AI`);
  if (states.existing > 0) parts.push(`${states.existing} existing`);
  return parts.length === 0 ? "No text fields" : parts.join(" · ");
}

type Selected = NonNullable<ReadData["selected"]>;

function ResourcePanel({
  data,
  selected,
  fetcher,
  busy,
}: {
  data: ReadData;
  selected: Selected;
  fetcher: ReturnType<typeof useFetcher<typeof action>>;
  busy: boolean;
}) {
  const initial = Object.fromEntries(
    selected.fields.map((f) => [f.key, f.translation]),
  );
  const [values, setValues] = useState<Record<string, string>>(initial);
  const savedKey = `${selected.id}|${data.locale}|${JSON.stringify(initial)}`;
  useResetWhenSaved(
    savedKey,
    useCallback(() => setValues(initial), [initial]),
  );
  const changed = selected.fields.filter(
    (f) => (values[f.key] ?? "") !== f.translation,
  );
  useSaveBar(SAVE_BAR_ID, changed.length > 0);

  const save = () =>
    fetcher.submit(
      {
        intent: "save",
        form: JSON.stringify({
          resource: selected.id,
          type: data.type,
          locale: data.locale,
          fields: changed.map((f) => ({
            key: f.key,
            value: values[f.key] ?? "",
            digest: f.digest,
          })),
        }),
      },
      { method: "post" },
    );

  const sourceOptions = [
    {
      value: "",
      label: `${localeLabel(data.primary.locale, data.primary.name)} — store default`,
    },
    ...data.allLocales
      .filter((l) => !l.primary)
      .map((l) => ({ value: l.locale, label: localeLabel(l.locale, l.name) })),
  ];

  return (
    <s-section heading={selected.title}>
      <ui-save-bar id={SAVE_BAR_ID}>
        <button
          variant="primary"
          onClick={save}
          {...(busy ? { loading: "" } : {})}
        >
          Save to Shopify
        </button>
        <button onClick={() => setValues(initial)}>Discard</button>
      </ui-save-bar>

      <s-stack direction="block" gap="base">
        <s-text color="subdued">
          {`${RESOURCE_TYPE_LABEL[data.type]} · ${describeResourceId(selected.id)} · ${localeLabel(selected.sourceLocale)} → ${localeLabel(data.locale)}`}
        </s-text>

        <s-box padding="base" border="base" borderRadius="base">
          <s-grid
            gridTemplateColumns="@container (inline-size <= 560px) 1fr, 1fr auto"
            gap="base"
            alignItems="end"
          >
            <Dropdown
              name="source"
              label="Written in"
              details={
                selected.sourceIsOverride
                  ? "Translated directly from this language, never through the store default."
                  : "The store default. Change it if this text was written in another language."
              }
              value={selected.sourceIsOverride ? selected.sourceLocale : ""}
              options={sourceOptions}
              onChange={(next) =>
                fetcher.submit(
                  {
                    intent: "set-source",
                    resource: selected.id,
                    type: data.type,
                    source: next,
                  },
                  { method: "post" },
                )
              }
              disabled={busy}
            />
            <s-stack direction="inline" gap="small-300" alignItems="center">
              {selected.detectedLocale &&
              selected.detectedLocale !== selected.sourceLocale ? (
                <s-text color="subdued">{`Looks like ${localeLabel(selected.detectedLocale)}`}</s-text>
              ) : null}
              <s-button
                type="button"
                onClick={() =>
                  fetcher.submit(
                    {
                      intent: "detect-source",
                      resource: selected.id,
                      type: data.type,
                    },
                    { method: "post" },
                  )
                }
                {...(busy || !data.aiConfigured ? { disabled: true } : {})}
              >
                Detect
              </s-button>
            </s-stack>
          </s-grid>
        </s-box>

        <s-stack direction="inline" gap="small-300">
          <s-button
            type="button"
            variant="primary"
            onClick={() =>
              fetcher.submit(
                {
                  intent: "translate",
                  resource: selected.id,
                  type: data.type,
                  locale: data.locale,
                  mode: "missing_outdated",
                },
                { method: "post" },
              )
            }
            {...(busy ||
            !data.aiConfigured ||
            selected.sourceLocale === data.locale
              ? { disabled: true }
              : {})}
            {...(busy ? { loading: true } : {})}
          >
            Translate missing and outdated with AI
          </s-button>
          <s-button
            type="button"
            onClick={() =>
              fetcher.submit(
                {
                  intent: "translate",
                  resource: selected.id,
                  type: data.type,
                  locale: data.locale,
                  mode: "force",
                },
                { method: "post" },
              )
            }
            {...(busy ||
            !data.aiConfigured ||
            selected.sourceLocale === data.locale
              ? { disabled: true }
              : {})}
          >
            Retranslate all AI fields
          </s-button>
        </s-stack>
        <s-text color="subdued">
          Fields you edit here are yours: the AI leaves them alone on every
          later run, unless the language allows overwriting everything.
        </s-text>

        <s-divider />

        {selected.fields.length === 0 ? (
          <s-text color="subdued">
            Shopify reports no translatable fields on this resource.
          </s-text>
        ) : null}
        {selected.fields.map((field) => {
          const long =
            field.type === "HTML" ||
            field.source.length > 120 ||
            field.source.includes("\n");
          const value = values[field.key] ?? "";
          return (
            <s-stack key={field.key} direction="block" gap="small-300">
              <s-stack direction="inline" gap="small-300" alignItems="center">
                <s-text type="strong">{field.label}</s-text>
                <FieldStateBadge state={field.state} />
                {!field.prose && field.key === "handle" ? (
                  <s-text color="subdued">
                    Not translated by AI; a translated handle changes the URL.
                  </s-text>
                ) : null}
              </s-stack>
              <s-grid
                gridTemplateColumns="@container (inline-size <= 720px) 1fr, 1fr 1fr"
                gap="base"
                alignItems="start"
              >
                <s-stack direction="block" gap="small-500">
                  <s-text color="subdued">{`Source · ${localeLabel(selected.sourceLocale)}`}</s-text>
                  <s-box
                    padding="small-200"
                    border="base"
                    borderRadius="base"
                    background="subdued"
                  >
                    <s-text>
                      {field.source.length > 1500
                        ? `${field.source.slice(0, 1500)}…`
                        : field.source}
                    </s-text>
                  </s-box>
                </s-stack>
                {long ? (
                  <s-text-area
                    label={`${field.label} · ${localeLabel(data.locale)}`}
                    rows={Math.min(
                      14,
                      Math.max(3, Math.ceil(field.source.length / 90)),
                    )}
                    value={value}
                    onInput={(event) =>
                      setValues((now) => ({
                        ...now,
                        [field.key]: event.currentTarget.value,
                      }))
                    }
                    onChange={(event) =>
                      setValues((now) => ({
                        ...now,
                        [field.key]: event.currentTarget.value,
                      }))
                    }
                    {...(busy ? { disabled: true } : {})}
                  />
                ) : (
                  <s-text-field
                    label={`${field.label} · ${localeLabel(data.locale)}`}
                    value={value}
                    onInput={(event) =>
                      setValues((now) => ({
                        ...now,
                        [field.key]: event.currentTarget.value,
                      }))
                    }
                    onChange={(event) =>
                      setValues((now) => ({
                        ...now,
                        [field.key]: event.currentTarget.value,
                      }))
                    }
                    {...(busy ? { disabled: true } : {})}
                  />
                )}
              </s-grid>
            </s-stack>
          );
        })}
      </s-stack>
    </s-section>
  );
}

function FieldStateBadge({ state }: { state: FieldState }) {
  const tone =
    state === "missing"
      ? ("warning" as const)
      : state === "outdated"
        ? ("critical" as const)
        : state === "manual"
          ? ("success" as const)
          : ("info" as const);
  return <s-badge tone={tone}>{FIELD_STATE_LABEL[state]}</s-badge>;
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
