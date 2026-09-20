/**
 * Translations: the vocabulary (docs/translations.md).
 *
 * Pure types and constants. Two systems meet here and are deliberately kept
 * apart in the names: **Shopify** owns whether a locale exists, is published
 * and is primary, and owns every original and translated string; **the
 * engine** (this app) owns whether the AI works on a language, what it may
 * change, and what it wrote.
 */

/** What Shopify says about one enabled locale. Read live, never stored. */
export interface ShopLocale {
  locale: string;
  name: string;
  primary: boolean;
  published: boolean;
  /** Market web presences this locale is enabled on. */
  webPresences: LocaleWebPresence[];
}

export interface LocaleWebPresence {
  id: string;
  /** Whether this locale is the presence's default rather than an alternate. */
  isDefault: boolean;
  /** Markets served by this presence, by name. */
  markets: Array<{ id: string; name: string; handle: string; status: string }>;
  /** The domain host, or the subfolder suffix, or null for the shop domain. */
  host: string | null;
  subfolderSuffix: string | null;
}

export type OverwritePolicy =
  | "protect_existing"
  | "update_ai_managed"
  | "overwrite_all";

export const OVERWRITE_POLICY_LABEL: Record<OverwritePolicy, string> = {
  protect_existing: "Protect every existing translation",
  update_ai_managed: "Protect human translations, update AI-managed ones",
  overwrite_all: "Allow AI to overwrite everything",
};

export type SyncMode = "missing" | "missing_outdated" | "force";

export const SYNC_MODE_LABEL: Record<SyncMode, string> = {
  missing: "Missing only",
  missing_outdated: "Missing and outdated",
  force: "Retranslate everything",
};

/** The engine's settings for one language. Nothing Shopify knows about. */
export interface LanguageSettings {
  locale: string;
  aiEnabled: boolean;
  autoTranslateNew: boolean;
  autoUpdateOutdated: boolean;
  contentScope: ContentGroup[];
  overwritePolicy: OverwritePolicy;
}

export function defaultLanguageSettings(locale: string): LanguageSettings {
  return {
    locale,
    aiEnabled: false,
    autoTranslateNew: false,
    autoUpdateOutdated: false,
    contentScope: [...ALL_CONTENT_GROUPS],
    overwritePolicy: "update_ai_managed",
  };
}

/**
 * Shopify's `TranslatableResourceType` values this app works on, and what
 * a merchant calls each group. The theme, email template and app-embed
 * types are deliberately absent: their keys are dynamic and their strings
 * are the theme's, not the catalogue's.
 */
export type ResourceType =
  | "PRODUCT"
  | "PRODUCT_OPTION"
  | "PRODUCT_OPTION_VALUE"
  | "COLLECTION"
  | "PAGE"
  | "BLOG"
  | "ARTICLE"
  | "MENU"
  | "LINK"
  | "METAFIELD"
  | "METAOBJECT"
  | "SHOP"
  | "SHOP_POLICY"
  | "FILTER"
  | "DELIVERY_METHOD_DEFINITION"
  | "SELLING_PLAN"
  | "SELLING_PLAN_GROUP";

export type ContentGroup =
  | "products"
  | "collections"
  | "pages"
  | "blogs"
  | "navigation"
  | "metafields"
  | "other";

export const ALL_CONTENT_GROUPS: readonly ContentGroup[] = [
  "products",
  "collections",
  "pages",
  "blogs",
  "navigation",
  "metafields",
  "other",
];

export const CONTENT_GROUPS: Record<
  ContentGroup,
  { label: string; types: readonly ResourceType[] }
> = {
  products: {
    label: "Products",
    types: ["PRODUCT", "PRODUCT_OPTION", "PRODUCT_OPTION_VALUE"],
  },
  collections: { label: "Collections", types: ["COLLECTION"] },
  pages: { label: "Pages", types: ["PAGE"] },
  blogs: { label: "Blogs & articles", types: ["BLOG", "ARTICLE"] },
  navigation: { label: "Navigation", types: ["MENU", "LINK"] },
  metafields: { label: "Metafields", types: ["METAFIELD", "METAOBJECT"] },
  other: {
    label: "Other supported content",
    types: [
      "SHOP",
      "SHOP_POLICY",
      "FILTER",
      "DELIVERY_METHOD_DEFINITION",
      "SELLING_PLAN",
      "SELLING_PLAN_GROUP",
    ],
  },
};

export const ALL_RESOURCE_TYPES: readonly ResourceType[] =
  ALL_CONTENT_GROUPS.flatMap((group) => CONTENT_GROUPS[group].types);

export const RESOURCE_TYPE_LABEL: Record<ResourceType, string> = {
  PRODUCT: "Product",
  PRODUCT_OPTION: "Product option",
  PRODUCT_OPTION_VALUE: "Option value",
  COLLECTION: "Collection",
  PAGE: "Page",
  BLOG: "Blog",
  ARTICLE: "Article",
  MENU: "Menu",
  LINK: "Menu link",
  METAFIELD: "Metafield",
  METAOBJECT: "Metaobject",
  SHOP: "Store details",
  SHOP_POLICY: "Store policy",
  FILTER: "Filter",
  DELIVERY_METHOD_DEFINITION: "Delivery method",
  SELLING_PLAN: "Selling plan",
  SELLING_PLAN_GROUP: "Selling plan group",
};

export function isResourceType(value: string): value is ResourceType {
  return (ALL_RESOURCE_TYPES as readonly string[]).includes(value);
}

export function isContentGroup(value: string): value is ContentGroup {
  return (ALL_CONTENT_GROUPS as readonly string[]).includes(value);
}

/** The resource types a set of content groups expands to, in a stable order. */
export function typesForGroups(groups: readonly ContentGroup[]): ResourceType[] {
  return ALL_RESOURCE_TYPES.filter((type) =>
    groups.some((group) => CONTENT_GROUPS[group].types.includes(type)),
  );
}

export function groupForType(type: ResourceType): ContentGroup {
  const found = ALL_CONTENT_GROUPS.find((group) =>
    CONTENT_GROUPS[group].types.includes(type),
  );
  // Every ResourceType is in exactly one group by construction.
  return found ?? "other";
}

/**
 * What a translatable key is called on screen. Shopify's keys are snake_case
 * field names; the merchant sees the field the admin shows.
 */
export const FIELD_LABEL: Record<string, string> = {
  title: "Title",
  body_html: "Description",
  summary_html: "Summary",
  handle: "URL handle",
  meta_title: "SEO title",
  meta_description: "SEO description",
  product_type: "Product type",
  name: "Name",
  value: "Value",
  label: "Label",
  description: "Description",
  alt: "Alt text",
  body: "Body",
  option_name: "Option name",
  address1: "Address",
  address2: "Address line 2",
  city: "City",
  zip: "Postcode",
  phone: "Phone",
};

export function fieldLabel(key: string): string {
  return FIELD_LABEL[key] ?? key.replace(/_/g, " ");
}

/**
 * Keys that are identifiers rather than prose. Shopify lists `handle` as
 * translatable, but a translated handle changes the URL of every localised
 * page, which is a decision and not a translation. Left to the editor.
 */
export const NEVER_AUTO_TRANSLATED_KEYS: ReadonlySet<string> = new Set([
  "handle",
]);

/** One translatable field of a resource as Shopify reports it. */
export interface SourceField {
  key: string;
  value: string;
  digest: string | null;
  /** Shopify's `LocalizableContentType`, e.g. STRING, HTML, RICH_TEXT_FIELD, URI. */
  type: string;
}

/** One existing translation as Shopify reports it. */
export interface ExistingTranslation {
  key: string;
  value: string;
  outdated: boolean;
  updatedAt: string | null;
}

/** What this app recorded about a field it wrote. */
export interface OwnershipRecord {
  key: string;
  locale: string;
  owner: "ai" | "manual";
  valueHash: string;
}

/**
 * The operational state of one field in one language, as the merchant sees
 * it. Never a mixture: the first condition that holds names it.
 */
export type FieldState =
  | "missing"
  | "outdated"
  | "ai"
  | "manual"
  | "existing";

export const FIELD_STATE_LABEL: Record<FieldState, string> = {
  missing: "Missing",
  outdated: "Outdated",
  ai: "AI",
  manual: "Edited by a person",
  existing: "Existing",
};

export interface GlossaryTerm {
  kind: "translate" | "protect";
  targetLocale: string | null;
  sourceTerm: string;
  targetTerm: string | null;
}

/** One turn of a chat request to the provider. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Why a translation came out as it did (docs/translations.md
 * § Explainability): stored with the sync item so a developer can see
 * which prompt, profile, terms and memory produced it, without storing the
 * prompt itself. Bounded: lists are capped, texts are not kept.
 */
export type TranslationTrace = {
  promptVersion: string;
  profileVersion: number | null;
  sourceLocale: string;
  /** How the source locale was decided: "override", "shopify_content" or "primary". */
  sourceReason: string;
  /** A detected locale that disagreed with the decision, if any. */
  sourceDisputedBy: string | null;
  targetLocale: string;
  contextKind: string;
  model: string | null;
  /** Provider requests made for this item, including corrections. */
  attempts: number;
  /** Fields answered from translation memory with no provider request. */
  reusedKeys: string[];
  /** Ids of the memory entries shown or reused. */
  memoryHitIds: string[];
  glossaryHits: number;
  /** Ids of the store terms shown. */
  termIds: string[];
  /** Per attempt, the violations validation found; empty when clean. */
  validation: Array<{ attempt: number; violations: Array<{ key: string; code: string; severity: string }> }>;
};
