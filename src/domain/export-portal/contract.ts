import { z } from "zod";

/**
 * The export portal API, as this app reads it (docs/sources.md § The
 * contract).
 *
 * The portal is a separate product with its own Shopify app, used by other
 * partners; Recharge Hub is one client of it. These schemas are the whole of
 * what the two agree on: every reply is parsed here before anything else
 * sees it, and a portal that answers something else is "unreadable", never
 * a crash. Version `v1` is in every path, so the portal can move on without
 * breaking this app.
 *
 * Pure: no clock, no fetch. Timestamps stay ISO strings until a screen
 * formats them.
 */

export const CONTRACT_VERSION = "v1";

/** Where the portal's API lives beneath its origin. */
export const API_PREFIX = `/api/${CONTRACT_VERSION}`;

/**
 * What a source can be configured with, described by the portal.
 *
 * The portal owns the fields of each source kind; this app only renders
 * them. That is what keeps one development: a new source kind, or a new
 * field on one, appears here without a change to this app.
 */
export const FIELD_TYPES = [
  "text",
  "textarea",
  "number",
  "boolean",
  "select",
  "secret",
  "url",
  "email",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const fieldOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
});

/**
 * A `{key}` placeholder a text field's value may use, and what it comes to
 * for this source (`example`), so the pattern editor can offer it as a chip.
 */
export const fieldTokenSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  example: z.string().nullable().optional(),
});
export type FieldToken = z.infer<typeof fieldTokenSchema>;

export const fieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(FIELD_TYPES),
  help: z.string().nullable().optional(),
  placeholder: z.string().nullable().optional(),
  required: z.boolean().optional(),
  /** Only for `select`. */
  options: z.array(fieldOptionSchema).optional(),
  /** Only for `text`: the placeholders the value may use. */
  tokens: z.array(fieldTokenSchema).optional(),
  /**
   * With `tokens`: the real record the examples come from — what it is
   * called, and the text the value is put in front of — for a preview.
   */
  sample: z.object({ label: z.string().min(1), after: z.string() }).optional(),
  /** A heading the field is grouped under, so a long form reads in parts. */
  group: z.string().nullable().optional(),
});
export type Field = z.infer<typeof fieldSchema>;

/**
 * A stored value. A `secret` field never comes back as its value: the portal
 * answers with a mask (or null when none is stored), and this app sends the
 * key only when a person typed a new one.
 */
export const fieldValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);
export type FieldValue = z.infer<typeof fieldValueSchema>;
export const fieldValuesSchema = z.record(z.string(), fieldValueSchema);
export type FieldValues = z.infer<typeof fieldValuesSchema>;

export const RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const runSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  status: z.enum(RUN_STATUSES),
  /** Who or what started it: a person's name, "schedule", "api". */
  triggeredBy: z.string().nullable().optional(),
  queuedAt: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  finishedAt: z.string().nullable().optional(),
  /** How many things the export carried, when the portal counts them. */
  itemCount: z.number().int().nonnegative().nullable().optional(),
  /** One line for a person: the error, or what was delivered where. */
  message: z.string().nullable().optional(),
  /** Where the produced file can be fetched, when there is one. */
  downloadUrl: z.string().url().nullable().optional(),
});
export type Run = z.infer<typeof runSchema>;

export const logLineSchema = z.object({
  at: z.string(),
  level: z.enum(["info", "warning", "error"]),
  message: z.string(),
});
export type LogLine = z.infer<typeof logLineSchema>;

export const SOURCE_HEALTH = [
  "ok",
  "needs_attention",
  "never_ran",
  "off",
] as const;
export type SourceHealth = (typeof SOURCE_HEALTH)[number];

export const scheduleSchema = z.object({
  mode: z.enum(["manual", "automatic"]),
  /** "Every day at 04:00", in the portal's words. */
  description: z.string().nullable().optional(),
  nextRunAt: z.string().nullable().optional(),
});
export type Schedule = z.infer<typeof scheduleSchema>;

/** A source as the list shows it. */
export const sourceSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  kindLabel: z.string().min(1),
  enabled: z.boolean(),
  /** Where it goes, in the portal's words: "SFTP partner-x", "Google Merchant". */
  destination: z.string().nullable().optional(),
  schedule: scheduleSchema,
  health: z.enum(SOURCE_HEALTH),
  lastRun: runSchema.nullable().optional(),
});
export type SourceSummary = z.infer<typeof sourceSummarySchema>;

/** A source with everything the editor needs. */
export const sourceSchema = sourceSummarySchema.extend({
  fields: z.array(fieldSchema),
  values: fieldValuesSchema,
  createdAt: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
  /** The same source in the portal's own admin, for what this app does not show. */
  portalUrl: z.string().url().nullable().optional(),
});
export type Source = z.infer<typeof sourceSchema>;

export const sourceTypeSchema = z.object({
  kind: z.string().min(1),
  label: z.string().min(1),
  description: z.string().nullable().optional(),
  fields: z.array(fieldSchema),
});
export type SourceType = z.infer<typeof sourceTypeSchema>;

export const connectionSchema = z.object({
  tenant: z.object({ id: z.string().min(1), name: z.string().min(1) }),
  shop: z.object({ domain: z.string().min(1) }),
  key: z
    .object({
      name: z.string().nullable().optional(),
      createdAt: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type Connection = z.infer<typeof connectionSchema>;

/** Reply envelopes, one per endpoint. */
/**
 * AI autofill (docs/sources.md § AI autofill): the portal's categorizer and
 * attribute reader, run against this app's product types and attributes.
 */
export const categorizeReplySchema = z.object({
  results: z.array(
    z.object({
      code: z.string(),
      categoryId: z.string().nullable(),
      confidence: z.number().min(0).max(1).nullable(),
      reason: z.string().nullable(),
    }),
  ),
});

export const extractAttributesReplySchema = z.object({
  values: z.array(
    z.object({
      attributeId: z.string(),
      variantId: z.string().nullable(),
      value: z.union([z.string(), z.array(z.string())]),
    }),
  ),
});

/** A product as the portal's AI reads it. `code` comes back on each result. */
export interface AiProduct {
  code: string;
  /** Lets the portal add its own supplier data for a product it created. */
  shopifyProductId: string;
  name: string;
  vendor?: string;
  productType?: string;
  category?: string;
  tags?: string[];
  description?: string;
  options?: string[];
  variants?: Array<{
    id: string;
    title: string;
    sku?: string;
    options?: Array<{ name: string; value: string }>;
  }>;
}

export interface CategorizeRequest {
  products: AiProduct[];
  categories: Array<{ id: string; label: string }>;
}

export interface ExtractAttributesRequest {
  product: AiProduct;
  attributes: Array<{
    id: string;
    name: string;
    description?: string;
    format: string;
    unit?: string;
    options?: Array<{ code: string; label: string }>;
    level: "product" | "variant";
  }>;
}

export const replies = {
  connection: connectionSchema,
  categorize: categorizeReplySchema,
  extractAttributes: extractAttributesReplySchema,
  sourceTypes: z.object({ types: z.array(sourceTypeSchema) }),
  sources: z.object({ sources: z.array(sourceSummarySchema) }),
  source: z.object({ source: sourceSchema }),
  run: z.object({ run: runSchema }),
  runs: z.object({ runs: z.array(runSchema) }),
  runDetail: z.object({
    run: runSchema,
    log: z.array(logLineSchema).optional().default([]),
  }),
} as const;

/**
 * What the portal answers with when it refuses. `errors` carries per-field
 * messages on a 422, keyed by the field's `key`, so the editor can put each
 * one under its input.
 */
export const errorReplySchema = z.object({
  error: z
    .object({
      code: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
  errors: z
    .array(z.object({ field: z.string(), message: z.string() }))
    .optional(),
});
export type ErrorReply = z.infer<typeof errorReplySchema>;

/** What this app sends when it changes a source. */
export interface SourceWrite {
  name?: string;
  enabled?: boolean;
  values?: FieldValues;
}

/** What this app sends when it creates one. */
export interface SourceCreate {
  kind: string;
  name: string;
  values: FieldValues;
}
