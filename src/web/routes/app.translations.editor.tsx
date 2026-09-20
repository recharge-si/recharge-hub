import { boundary } from "@shopify/shopify-app-react-router/server";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunction,
} from "react-router";
import { z } from "zod";

import { detectLanguage, isConfigured } from "~/adapters/ai/openai.server";
import { appendEvent } from "~/adapters/db/repositories/event-log.server";
import {
  forgetMemory,
  rememberTranslations,
} from "~/adapters/db/repositories/translation-intelligence.server";
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
import { ContextSource } from "~/adapters/translations/context.server";
import { hashValue } from "~/adapters/translations/engine.server";
import { translateResourceNow } from "~/adapters/translations/inline.server";
import { describeConfidence, detectionSample } from "~/domain/translations/detection";
import { isMemorable, memoryKey } from "~/domain/translations/memory";
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
import { formatListDateTime } from "~/web/lib/datetime";
import {
  actorFromSession,
  principalFromSession,
} from "~/web/lib/principal.server";
import {
  TRANSLATION_ROUTES,
  describeResourceId,
  localeLabel,
} from "~/web/lib/translations";
import { useResetWhenSaved, useSaveBar } from "~/web/lib/use-save-bar";

/**
 * The translation workspace (docs/translations.md § Editor): a rail of
 * resources on the left that stays where it is, and the one chosen resource
 * on the right with every field's source beside its translation.
 *
 * Choosing a resource never leaves the page. The rail is what the route
 * loader reads — a page of Shopify's `translatableResources`, filtered here
 * because Shopify offers no query on that connection — and the chosen
 * resource is a second, smaller read of the same loader (`part=resource`)
 * made from the browser. The address is kept current so a reload or a
 * bookmark opens the same resource, but `shouldRevalidate` keeps a change of
 * resource from re-reading the whole rail.
 *
 * Saving is `translationsRegister` — the translation lands in Shopify and
 * nowhere else — and records the field as a person's work, which the AI
 * then leaves alone. An emptied field is `translationsRemove`. The source
 * language a resource is written in is shown and can be changed here;
 * detection only suggests.
 */
const SAVE_BAR_ID = "translation-editor-save-bar";
const PAGE = 25;

/** The rail folds away behind the editor below this width of the workspace. */
const NARROW = "(inline-size <= 760px)";
const WIDE = "(inline-size > 760px)";

const STATUS_FILTERS = ["all", "missing", "outdated", "manual", "ai"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  all: "Everything",
  missing: "Missing",
  outdated: "Outdated",
  manual: "Edited by a person",
  ai: "Written by AI",
};

function isStatusFilter(value: string): value is StatusFilter {
  return (STATUS_FILTERS as readonly string[]).includes(value);
}

interface ListParams {
  locale: string;
  type: ResourceType;
  status: StatusFilter;
  q: string;
  after?: string | null;
}

function editorUrl(
  params: ListParams & { resource?: string | null; part?: "resource" },
): string {
  const search = new URLSearchParams();
  search.set("locale", params.locale);
  search.set("type", params.type);
  if (params.status !== "all") search.set("status", params.status);
  if (params.q) search.set("q", params.q);
  if (params.after) search.set("after", params.after);
  if (params.resource) search.set("resource", params.resource);
  if (params.part) search.set("part", params.part);
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

/** One resource as the editor pane shows it. */
function describeSelected(
  resource: TranslatableResource,
  locale: string,
  primaryLocale: string,
  ownership: readonly OwnershipRecord[],
  override: { sourceLocale: string; detectedLocale: string | null } | null,
) {
  const translations = new Map(
    (resource.translations.get(locale) ?? []).map((t) => [t.key, t]),
  );
  const records = new Map(
    ownership.filter((r) => r.locale === locale).map((r) => [r.key, r]),
  );
  return {
    id: resource.resourceId,
    title: resourceTitle(resource.fields, resource.resourceId),
    sourceLocale: override?.sourceLocale ?? primaryLocale,
    sourceIsOverride:
      override !== null && override.sourceLocale !== primaryLocale,
    detectedLocale: override?.detectedLocale ?? null,
    fields: resource.fields
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
          state: classifyField(translation, records.get(field.key), hashValue),
          outdated: translation?.outdated ?? false,
          updatedAt: translation?.updatedAt ?? null,
          prose: isTranslatableField(field),
        };
      }),
  };
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
  const status: StatusFilter = isStatusFilter(statusParam)
    ? statusParam
    : "all";
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const after = url.searchParams.get("after");
  const selectedId = url.searchParams.get("resource");

  // The small read: one resource for the pane, nothing for the rail.
  if (url.searchParams.get("part") === "resource") {
    if (!selectedId) return { kind: "resource" as const, selected: null };
    const [read, ownership, override] = await Promise.all([
      readTranslatableResourcesByIds(admin, {
        ids: [selectedId],
        locales: [locale],
      }),
      listOwnership(principal, [selectedId]),
      getSourceOverride(principal, selectedId),
    ]);
    const resource = read[0];
    return {
      kind: "resource" as const,
      selected: resource
        ? describeSelected(
            resource,
            locale,
            primary.locale,
            ownership.get(selectedId) ?? [],
            override,
          )
        : null,
    };
  }

  // The rail: a search by title where the type allows it, else a page.
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
  const selected =
    selectedResource && selectedId
      ? describeSelected(
          selectedResource,
          locale,
          primary.locale,
          ownership.get(selectedId) ?? [],
          override,
        )
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
    after,
    searchable: isSearchable(type),
    rows,
    filteredOut: page.resources.length - rows.length,
    hasNextPage: page.hasNextPage,
    endCursor: page.endCursor,
    selected,
    aiConfigured: isConfigured(),
  };
};

/**
 * Changing only which resource is open is the one navigation that must not
 * re-read the rail: the pane fetches the resource itself. Everything else —
 * a filter, a search, a page, and every save — revalidates as usual.
 */
export const shouldRevalidate: ShouldRevalidateFunction = ({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}) => {
  if (formMethod && formMethod !== "GET") return defaultShouldRevalidate;
  if (currentUrl.pathname !== nextUrl.pathname) return defaultShouldRevalidate;
  const before = new URLSearchParams(currentUrl.search);
  const next = new URLSearchParams(nextUrl.search);
  before.delete("resource");
  next.delete("resource");
  before.sort();
  next.sort();
  if (before.toString() === next.toString()) return false;
  return defaultShouldRevalidate;
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

    // A person's translation is the strongest signal memory gets: it is
    // reused for the same string and shown to the model for related ones.
    const [locales, sourceRead, override] = await Promise.all([
      listShopLocales(admin),
      readTranslatableResourcesByIds(admin, { ids: [resource], locales: [] }),
      getSourceOverride(principal, resource),
    ]);
    const primaryLocale =
      locales.kind === "read"
        ? (locales.locales.find((l) => l.primary)?.locale ?? null)
        : null;
    const sourceLocale = override?.sourceLocale ?? primaryLocale;
    const sourceFields = new Map(
      (sourceRead[0]?.fields ?? []).map((field) => [field.key, field]),
    );

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
      if (sourceLocale && sourceLocale !== locale) {
        const pairs = writes.flatMap((field) => {
          const source = sourceFields.get(field.key);
          if (!source || !isMemorable(source)) return [];
          return [
            {
              sourceLocale,
              targetLocale: locale,
              sourceKey: memoryKey(source.value),
              sourceText: source.value.trim(),
              targetText: field.value.trim(),
              resourceType: type,
              resourceId: resource,
            },
          ];
        });
        await rememberTranslations(principal, pairs, "manual", new Date());
      }
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
      if (sourceLocale)
        await forgetMemory(principal, {
          sourceLocale,
          targetLocale: locale,
          sourceKeys: removals.flatMap((field) => {
            const source = sourceFields.get(field.key);
            return source ? [memoryKey(source.value)] : [];
          }),
        });
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
    const sample = detectionSample(found.fields.filter(isTranslatableField));
    if (sample.trim() === "")
      return {
        ok: false,
        message: "There is no text to detect a language from.",
      };
    // What sits next to the resource helps with a short label; the store's
    // own languages are what the answer is most likely among.
    const contexts = new ContextSource(admin);
    await contexts.prime([{ resourceId: resource, type: typeParam }]);
    const neighbourText = await contexts.neighbourText(
      resource,
      typeParam,
      resourceTitle(found.fields, resource),
    );
    const detected = await detectLanguage(principal, sample, {
      resourceId: resource,
      resourceType: typeParam,
      storeLocale: primary.locale,
      candidateLocales:
        locales.kind === "read" ? locales.locales.map((l) => l.locale) : [],
      neighbourText,
    });
    if (detected.kind === "failed")
      return { ok: false, message: detected.message };
    await recordDetectedSource(principal, {
      resourceId: resource,
      resourceType: typeParam,
      detectedLocale: detected.locale,
      detectedConfidence: detected.confidence,
      primaryLocale: primary.locale,
    });
    const confidence = describeConfidence(detected.confidence);
    return {
      ok: true,
      message: detected.shortSample
        ? `This may be ${localeLabel(detected.locale)} (${confidence}). Nothing changed; set it as the source only if you are sure.`
        : `This looks like ${localeLabel(detected.locale)} (${confidence}). Nothing changed; set it as the source if that is right.`,
    };
  }

  return { ok: false, message: "Unknown action." };
};

type LoaderData = Awaited<ReturnType<typeof loader>>;
type ReadData = Extract<LoaderData, { kind: "read" }>;
type Selected = NonNullable<ReadData["selected"]>;
type Row = ReadData["rows"][number];

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
  if (data.kind === "resource") {
    // Only ever answered to the pane's own fetch, never rendered as a page.
    return null;
  }
  return (
    <Workspace
      key={`${data.locale}|${data.type}|${data.status}|${data.q}|${data.after ?? ""}`}
      data={data}
      fetcher={fetcher}
      result={result ?? null}
    />
  );
}

/** The chosen resource as the pane knows it: what it shows, or why not. */
type Pane =
  | { kind: "none" }
  | { kind: "loading"; id: string; title: string }
  | { kind: "missing"; id: string }
  | { kind: "ready"; id: string; selected: Selected };

function Workspace({
  data,
  fetcher,
  result,
}: {
  data: ReadData;
  fetcher: ReturnType<typeof useFetcher<typeof action>>;
  result: ActionResult | null;
}) {
  const navigate = useNavigate();
  const resourceFetcher = useFetcher<typeof loader>();
  const busy = fetcher.state !== "idle";

  // The page the rail is on travels with every address built here, so
  // choosing a resource on a later page does not fall back to the first.
  const list: ListParams = {
    locale: data.locale,
    type: data.type,
    status: data.status,
    q: data.q,
    after: data.after,
  };

  const [pane, setPane] = useState<Pane>(() =>
    data.selected
      ? { kind: "ready", id: data.selected.id, selected: data.selected }
      : { kind: "none" },
  );
  const selectedId = pane.kind === "none" ? null : pane.id;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  // A save or a translation revalidates the loader, which then carries the
  // open resource fresh. The pane takes it only when it is still the one open.
  useEffect(() => {
    const fresh = data.selected;
    if (fresh && fresh.id === selectedRef.current)
      setPane({ kind: "ready", id: fresh.id, selected: fresh });
  }, [data]);

  useEffect(() => {
    const answer = resourceFetcher.data;
    if (!answer || answer.kind !== "resource") return;
    const wanted = selectedRef.current;
    if (wanted === null) return;
    if (answer.selected && answer.selected.id === wanted)
      setPane({ kind: "ready", id: wanted, selected: answer.selected });
    else if (!answer.selected)
      setPane((now) =>
        now.kind === "loading" && now.id === wanted
          ? { kind: "missing", id: wanted }
          : now,
      );
  }, [resourceFetcher.data]);

  const choose = async (row: Row | null) => {
    if (typeof shopify !== "undefined") {
      // Unsaved edits on the open resource: the merchant decides first.
      // The confirmation resolves at once when no save bar is showing; an
      // App Bridge without it lets the change through unasked rather than
      // holding the rail hostage.
      const confirm = shopify.saveBar.leaveConfirmation;
      if (typeof confirm === "function") {
        try {
          await confirm.call(shopify.saveBar);
        } catch {
          return;
        }
      }
    }
    if (row === null) {
      setPane({ kind: "none" });
      void navigate(editorUrl(list), { replace: true });
      return;
    }
    setPane({ kind: "loading", id: row.id, title: row.title });
    void resourceFetcher.load(
      editorUrl({ ...list, resource: row.id, part: "resource" }),
    );
    void navigate(editorUrl({ ...list, resource: row.id }), {
      replace: true,
    });
  };

  const index = data.rows.findIndex((row) => row.id === selectedId);
  const previous = index > 0 ? (data.rows[index - 1] ?? null) : null;
  const next =
    index >= 0 && index < data.rows.length - 1
      ? (data.rows[index + 1] ?? null)
      : null;

  // A new filter or search starts from the first page; only "Next page"
  // itself carries a cursor forward.
  const open = (patch: Partial<ListParams>) =>
    void navigate(editorUrl({ ...list, after: null, ...patch }));

  const hasSelection = pane.kind !== "none";

  return (
    <s-page heading="Editor" inlineSize="large">
      <s-link slot="breadcrumb-actions" href={TRANSLATION_ROUTES.languages}>
        Translations
      </s-link>

      <s-stack direction="block" gap="base">
        <TranslationsNav current="editor" />

        {result && !result.ok ? (
          <s-banner tone="critical" heading="That did not work">
            <s-paragraph>{result.message}</s-paragraph>
          </s-banner>
        ) : null}

        <s-query-container id="translation-workspace" containerName="workspace">
          <s-grid
            gridTemplateColumns={`@container workspace ${NARROW} 1fr, 288px minmax(0, 1fr)`}
            gap="base"
            alignItems="stretch"
          >
            {/*
             * On a phone the rail and the pane take turns: the rail until
             * something is chosen, the pane with a way back after.
             */}
            <s-box
              display={
                hasSelection
                  ? `@container workspace ${NARROW} none, auto`
                  : "auto"
              }
            >
              <Rail
                data={data}
                selectedId={selectedId}
                busy={busy}
                onChoose={(row) => void choose(row)}
                onOpen={open}
              />
            </s-box>

            <s-box
              display={
                hasSelection
                  ? "auto"
                  : `@container workspace ${NARROW} none, auto`
              }
            >
              {pane.kind === "ready" ? (
                <ResourcePane
                  key={`${pane.id}|${data.locale}`}
                  data={data}
                  selected={pane.selected}
                  fetcher={fetcher}
                  busy={busy}
                  previous={previous}
                  next={next}
                  onChoose={(row) => void choose(row)}
                />
              ) : (
                <PanePlaceholder
                  data={data}
                  pane={pane}
                  onBack={() => void choose(null)}
                />
              )}
            </s-box>
          </s-grid>
        </s-query-container>
      </s-stack>
    </s-page>
  );
}

function Rail({
  data,
  selectedId,
  busy,
  onChoose,
  onOpen,
}: {
  data: ReadData;
  selectedId: string | null;
  busy: boolean;
  onChoose: (row: Row) => void;
  onOpen: (patch: Partial<ListParams>) => void;
}) {
  const [q, setQ] = useState(data.q);
  useResetWhenSaved(
    data.q,
    useCallback(() => setQ(data.q), [data.q]),
  );
  const noun = RESOURCE_TYPE_LABEL[data.type].toLowerCase();

  return (
    /*
     * The rail stays put while the pane scrolls, so the next resource is
     * always one click away, and its list scrolls inside the rail rather
     * than pushing the pane down the page. Position and overflow are
     * layout, which Polaris leaves to the page (compare the pattern editor's
     * list); nothing is drawn here that Polaris did not draw.
     */
    <div
      style={{
        position: "sticky",
        top: "16px",
        maxHeight: "calc(100vh - 32px)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <s-section padding="none" accessibilityLabel="Resources">
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            maxHeight: "calc(100vh - 32px)",
          }}
        >
          <s-box padding="small-200">
            <s-stack direction="block" gap="small-300">
              <Dropdown
                name="locale"
                label="Translate into"
                hideLabel
                value={data.locale}
                options={data.languages.map((l) => ({
                  value: l.locale,
                  label: localeLabel(l.locale, l.name),
                }))}
                onChange={(next) => onOpen({ locale: next })}
                disabled={busy}
              />
              <s-grid gridTemplateColumns="1fr 1fr" gap="small-300">
                <Dropdown
                  name="type"
                  label="Content"
                  hideLabel
                  value={data.type}
                  options={ALL_RESOURCE_TYPES.map((type) => ({
                    value: type,
                    label: RESOURCE_TYPE_LABEL[type],
                  }))}
                  onChange={(next) => {
                    if (isResourceType(next)) onOpen({ type: next });
                  }}
                  disabled={busy}
                />
                <Dropdown
                  name="status"
                  label="Show"
                  hideLabel
                  value={data.status}
                  options={STATUS_FILTERS.map((status) => ({
                    value: status,
                    label: STATUS_FILTER_LABEL[status],
                  }))}
                  onChange={(next) => {
                    if (isStatusFilter(next)) onOpen({ status: next });
                  }}
                  disabled={busy}
                />
              </s-grid>
              <s-search-field
                label={`Search ${noun}s by title`}
                labelAccessibilityVisibility="exclusive"
                placeholder={
                  data.searchable
                    ? `Search ${noun}s`
                    : `${RESOURCE_TYPE_LABEL[data.type]}s cannot be searched`
                }
                value={q}
                onInput={(event) => setQ(event.currentTarget.value)}
                onChange={(event) => {
                  setQ(event.currentTarget.value);
                  onOpen({ q: event.currentTarget.value });
                }}
                {...(busy || !data.searchable ? { disabled: true } : {})}
              />
            </s-stack>
          </s-box>

          <s-divider />

          <div
            style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto" }}
            role="presentation"
          >
            <s-box padding="small-400">
              <s-stack
                direction="block"
                gap="none"
                accessibilityLabel={`${RESOURCE_TYPE_LABEL[data.type]}s`}
              >
                {data.rows.length === 0 ? (
                  <s-box padding="small-200">
                    <s-text color="subdued">
                      {data.filteredOut > 0
                        ? `None of the ${data.filteredOut} on this page are "${STATUS_FILTER_LABEL[data.status].toLowerCase()}".`
                        : data.q
                          ? `No ${noun} matches "${data.q}".`
                          : `No ${noun}s here.`}
                    </s-text>
                  </s-box>
                ) : null}
                {data.rows.map((row) => (
                  <RailRow
                    key={row.id}
                    row={row}
                    current={row.id === selectedId}
                    onChoose={() => onChoose(row)}
                  />
                ))}
              </s-stack>
            </s-box>
          </div>

          <s-divider />

          <s-box paddingInline="small-200" paddingBlock="small-300">
            <s-grid
              gridTemplateColumns="1fr auto"
              gap="small-300"
              alignItems="center"
            >
              <s-text color="subdued">
                {data.rows.length === 1
                  ? `1 ${noun}`
                  : `${data.rows.length} ${noun}s`}
                {data.filteredOut > 0 ? ` · ${data.filteredOut} hidden` : ""}
              </s-text>
              {data.hasNextPage && data.endCursor ? (
                <s-button
                  variant="tertiary"
                  icon="chevron-right"
                  onClick={() => onOpen({ after: data.endCursor })}
                  {...(busy ? { disabled: true } : {})}
                >
                  Next page
                </s-button>
              ) : null}
            </s-grid>
          </s-box>
        </div>
      </s-section>
    </div>
  );
}

function RailRow({
  row,
  current,
  onChoose,
}: {
  row: Row;
  current: boolean;
  onChoose: () => void;
}) {
  const needsWork = row.states.missing + row.states.outdated;
  return (
    <s-clickable
      type="button"
      onClick={onChoose}
      background={current ? "subdued" : "transparent"}
      borderRadius="base"
      paddingInline="small-200"
      paddingBlock="small-300"
      inlineSize="100%"
      accessibilityLabel={`${row.title}${current ? ", open" : ""}${
        needsWork > 0 ? `, ${summariseStates(row.states)}` : ""
      }`}
    >
      <s-grid
        gridTemplateColumns="minmax(0, 1fr) auto"
        gap="small-300"
        alignItems="center"
      >
        <s-paragraph lineClamp={1}>
          <s-text type={current ? "strong" : "generic"}>{row.title}</s-text>
        </s-paragraph>
        {/*
         * Colour marks what needs a person: a count of missing or outdated
         * fields, and nothing for a resource that is done.
         */}
        {row.states.missing > 0 ? (
          <s-badge tone="warning" size="base">
            {`${row.states.missing} missing`}
          </s-badge>
        ) : row.states.outdated > 0 ? (
          <s-badge tone="critical" size="base">
            {`${row.states.outdated} outdated`}
          </s-badge>
        ) : null}
      </s-grid>
    </s-clickable>
  );
}

function summariseStates(states: StateCounts): string {
  const parts: string[] = [];
  if (states.missing > 0) parts.push(`${states.missing} missing`);
  if (states.outdated > 0) parts.push(`${states.outdated} outdated`);
  if (states.manual > 0) parts.push(`${states.manual} by a person`);
  if (states.ai > 0) parts.push(`${states.ai} by AI`);
  if (states.existing > 0) parts.push(`${states.existing} existing`);
  return parts.length === 0 ? "no text fields" : parts.join(", ");
}

/** The narrow-only way back from the pane to the rail. */
function BackToRail({ data, onBack }: { data: ReadData; onBack: () => void }) {
  return (
    <s-box display={`@container workspace ${WIDE} none, auto`}>
      <s-button variant="tertiary" icon="arrow-left" onClick={onBack}>
        {`All ${RESOURCE_TYPE_LABEL[data.type].toLowerCase()}s`}
      </s-button>
    </s-box>
  );
}

function PanePlaceholder({
  data,
  pane,
  onBack,
}: {
  data: ReadData;
  pane: Exclude<Pane, { kind: "ready" }>;
  onBack: () => void;
}) {
  const noun = RESOURCE_TYPE_LABEL[data.type].toLowerCase();
  const needsWork = data.rows.filter(
    (row) => row.states.missing + row.states.outdated > 0,
  ).length;

  if (pane.kind === "loading")
    return (
      <s-section padding="none">
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            <BackToRail data={data} onBack={onBack} />
            <s-stack direction="block" gap="small-500">
              <s-heading>{pane.title}</s-heading>
              <s-text color="subdued">
                {`${RESOURCE_TYPE_LABEL[data.type]} · ${localeLabel(data.primary.locale, data.primary.name)} → ${localeLabel(data.locale)}`}
              </s-text>
            </s-stack>
          </s-stack>
        </s-box>
        <s-divider />
        <s-box padding="large">
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-spinner size="base" accessibilityLabel="Reading from Shopify" />
            <s-text color="subdued">Reading from Shopify</s-text>
          </s-stack>
        </s-box>
      </s-section>
    );

  if (pane.kind === "missing")
    return (
      <s-section padding="none">
        <s-box padding="base">
          <s-stack direction="block" gap="base">
            <BackToRail data={data} onBack={onBack} />
            <s-heading>Not found</s-heading>
            <s-text color="subdued">
              {`Shopify has no ${noun} ${describeResourceId(pane.id)} any more. Pick another on the left.`}
            </s-text>
          </s-stack>
        </s-box>
      </s-section>
    );

  return (
    <s-section padding="none">
      <s-box padding="large">
        <s-stack direction="block" gap="small-300">
          <s-heading>{`Pick a ${noun} to translate`}</s-heading>
          <s-text color="subdued">
            {data.rows.length === 0
              ? "Nothing is listed on the left. Change the content or the filter, or search for a title."
              : needsWork > 0
                ? `${needsWork} of the ${data.rows.length} listed ${data.rows.length === 1 ? "needs" : "need"} work in ${localeLabel(data.locale)}. Each field shows the ${localeLabel(data.primary.locale, data.primary.name)} text beside its translation, and who wrote it.`
                : `Everything listed is translated into ${localeLabel(data.locale)}. Open one to read it beside the ${localeLabel(data.primary.locale, data.primary.name)} text.`}
          </s-text>
        </s-stack>
      </s-box>
    </s-section>
  );
}

function ResourcePane({
  data,
  selected,
  fetcher,
  busy,
  previous,
  next,
  onChoose,
}: {
  data: ReadData;
  selected: Selected;
  fetcher: ReturnType<typeof useFetcher<typeof action>>;
  busy: boolean;
  previous: Row | null;
  next: Row | null;
  onChoose: (row: Row | null) => void;
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

  const translate = (mode: "missing_outdated" | "force") =>
    fetcher.submit(
      {
        intent: "translate",
        resource: selected.id,
        type: data.type,
        locale: data.locale,
        mode,
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

  const canTranslate =
    !busy && data.aiConfigured && selected.sourceLocale !== data.locale;
  const needsWork = selected.fields.filter(
    (f) => f.prose && (f.state === "missing" || f.state === "outdated"),
  ).length;

  return (
    <s-section padding="none" accessibilityLabel={selected.title}>
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

      {/* The header: what is open, where it goes, and the AI. */}
      <s-box padding="base">
        <s-stack direction="block" gap="small-300">
          <BackToRail data={data} onBack={() => onChoose(null)} />
          <s-grid
            gridTemplateColumns={`@container workspace (inline-size <= 980px) 1fr, minmax(0, 1fr) auto`}
            gap="base"
            alignItems="start"
          >
            <s-stack direction="block" gap="small-500">
              <s-heading lineClamp={2}>{selected.title}</s-heading>
              <s-text color="subdued">
                {`${RESOURCE_TYPE_LABEL[data.type]} · ${describeResourceId(selected.id)} · ${localeLabel(selected.sourceLocale)} → ${localeLabel(data.locale)}`}
              </s-text>
            </s-stack>
            <s-stack direction="inline" gap="small-300" alignItems="center">
              <s-button-group accessibilityLabel="Move through the list">
                <s-button
                  variant="secondary"
                  icon="chevron-up"
                  accessibilityLabel={
                    previous ? `Previous: ${previous.title}` : "Previous"
                  }
                  onClick={() => previous && onChoose(previous)}
                  {...(previous ? {} : { disabled: true })}
                />
                <s-button
                  variant="secondary"
                  icon="chevron-down"
                  accessibilityLabel={next ? `Next: ${next.title}` : "Next"}
                  onClick={() => next && onChoose(next)}
                  {...(next ? {} : { disabled: true })}
                />
              </s-button-group>
              <s-button
                variant="secondary"
                onClick={() => translate("force")}
                {...(canTranslate ? {} : { disabled: true })}
              >
                Retranslate AI fields
              </s-button>
              <s-button
                variant="primary"
                onClick={() => translate("missing_outdated")}
                {...(canTranslate && needsWork > 0 ? {} : { disabled: true })}
                {...(busy ? { loading: true } : {})}
              >
                {needsWork > 0
                  ? `Translate ${needsWork} with AI`
                  : "Translate with AI"}
              </s-button>
            </s-stack>
          </s-grid>
        </s-stack>
      </s-box>

      <s-divider />

      {/*
       * Capped: two columns of prose read best around 500px each, and a
       * wide admin window is for the rail beside them, not for longer lines.
       */}
      <s-box padding="base" maxInlineSize="1080px">
        <s-stack direction="block" gap="large">
          <SourceRow
            data={data}
            selected={selected}
            fetcher={fetcher}
            busy={busy}
            options={sourceOptions}
          />

          {selected.fields.length === 0 ? (
            <s-text color="subdued">
              Shopify reports no translatable fields on this resource.
            </s-text>
          ) : null}

          {selected.fields.map((field) => (
            <FieldRow
              key={field.key}
              field={field}
              sourceLocale={selected.sourceLocale}
              targetLocale={data.locale}
              value={values[field.key] ?? ""}
              busy={busy}
              onChange={(value) =>
                setValues((now) => ({ ...now, [field.key]: value }))
              }
            />
          ))}

          <s-text color="subdued">
            Fields you edit here are yours: the AI leaves them alone on every
            later run, unless the language allows overwriting everything.
          </s-text>
        </s-stack>
      </s-box>
    </s-section>
  );
}

/** Which language the resource is written in: stated, changeable, detectable. */
function SourceRow({
  data,
  selected,
  fetcher,
  busy,
  options,
}: {
  data: ReadData;
  selected: Selected;
  fetcher: ReturnType<typeof useFetcher<typeof action>>;
  busy: boolean;
  options: { value: string; label: string }[];
}) {
  const suggestion =
    selected.detectedLocale && selected.detectedLocale !== selected.sourceLocale
      ? `Looks like ${localeLabel(selected.detectedLocale)}.`
      : null;
  return (
    <s-grid
      gridTemplateColumns="@container workspace (inline-size <= 640px) 1fr, auto minmax(200px, 320px) auto minmax(0, 1fr)"
      gap="small-300"
      alignItems="center"
    >
      <s-text color="subdued">Written in</s-text>
      <Dropdown
        name="source"
        label="Written in"
        hideLabel
        value={selected.sourceIsOverride ? selected.sourceLocale : ""}
        options={options}
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
      <s-button
        variant="tertiary"
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
      <s-text color="subdued">
        {suggestion ??
          (selected.sourceIsOverride
            ? "Translated directly from this language, never through the store default."
            : selected.sourceLocale === data.locale
              ? `Written in ${localeLabel(data.locale)} already, so there is nothing to translate.`
              : "")}
      </s-text>
    </s-grid>
  );
}

type Field = Selected["fields"][number];

/** One field: its source on the left, its translation on the right. */
function FieldRow({
  field,
  sourceLocale,
  targetLocale,
  value,
  busy,
  onChange,
}: {
  field: Field;
  sourceLocale: string;
  targetLocale: string;
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
}) {
  const long =
    field.type === "HTML" ||
    field.source.length > 120 ||
    field.source.includes("\n");
  const rows = Math.min(16, Math.max(3, Math.ceil(field.source.length / 80)));
  const targetLabel = `${field.label} · ${localeLabel(targetLocale)}`;

  return (
    <s-grid
      gridTemplateColumns={`@container workspace (inline-size <= 900px) 1fr, minmax(0, 1fr) minmax(0, 1fr)`}
      gap="base"
      alignItems="stretch"
    >
      <s-stack direction="block" gap="small-400">
        <s-stack direction="inline" gap="small-300" alignItems="center">
          <s-text type="strong">{field.label}</s-text>
          <FieldStateBadge state={field.state} />
          <s-text color="subdued">{localeLabel(sourceLocale)}</s-text>
        </s-stack>
        <s-box
          padding="small-200"
          border="base"
          borderRadius="base"
          background="subdued"
          minBlockSize={long ? "100%" : "0"}
        >
          {/*
           * Source text keeps its line breaks and scrolls past a screen's
           * worth rather than being cut off; a translator needs all of it.
           */}
          <div
            style={{
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              maxHeight: "420px",
              overflowY: "auto",
            }}
          >
            {field.source === "" ? (
              <s-text color="subdued">Empty</s-text>
            ) : (
              <s-text>{field.source}</s-text>
            )}
          </div>
        </s-box>
      </s-stack>

      <s-stack direction="block" gap="small-400">
        <s-stack
          direction="inline"
          gap="small-300"
          alignItems="center"
          justifyContent="space-between"
        >
          <s-text color="subdued">{localeLabel(targetLocale)}</s-text>
          <s-text color="subdued">
            {!field.prose && field.key === "handle"
              ? "Not translated by AI; a translated handle changes the URL."
              : field.updatedAt
                ? `Updated ${formatListDateTime(field.updatedAt)}`
                : ""}
          </s-text>
        </s-stack>
        {long ? (
          <s-text-area
            label={targetLabel}
            labelAccessibilityVisibility="exclusive"
            placeholder="Not translated yet"
            rows={rows}
            value={value}
            onInput={(event) => onChange(event.currentTarget.value)}
            onChange={(event) => onChange(event.currentTarget.value)}
            {...(busy ? { disabled: true } : {})}
          />
        ) : (
          <s-text-field
            label={targetLabel}
            labelAccessibilityVisibility="exclusive"
            placeholder="Not translated yet"
            value={value}
            onInput={(event) => onChange(event.currentTarget.value)}
            onChange={(event) => onChange(event.currentTarget.value)}
            {...(busy ? { disabled: true } : {})}
          />
        )}
      </s-stack>
    </s-grid>
  );
}

/**
 * Colour marks what needs a person: missing and outdated. Who wrote an
 * existing translation is information, not an alarm.
 */
function FieldStateBadge({ state }: { state: FieldState }) {
  const tone =
    state === "missing"
      ? ("warning" as const)
      : state === "outdated"
        ? ("critical" as const)
        : state === "ai"
          ? ("info" as const)
          : ("neutral" as const);
  return (
    <s-badge tone={tone} size="base">
      {FIELD_STATE_LABEL[state]}
    </s-badge>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
