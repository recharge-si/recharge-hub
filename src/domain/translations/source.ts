import { sameLanguage } from "~/domain/translations/locale";

/**
 * Which language a resource is translated *from* (docs/translations.md
 * § Source language). One function decides it, so the prompt, the sync
 * record and the trace all name the same locale and the model is never told
 * to translate a language into itself.
 *
 * Precedence, highest first:
 *
 * 1. A source override a person set for the resource. That is the
 *    confirmed answer — a detection a person accepted becomes an override.
 * 2. The locale Shopify reports on the resource's own translatable content,
 *    when it is not the primary locale (Shopify reports the primary today,
 *    but the field exists and is honoured if it ever says otherwise).
 * 3. The store's primary locale.
 *
 * A detected locale that nobody confirmed never decides; it is carried in
 * the result so the trace can say it disagreed.
 */

export type SourceReason = "override" | "shopify_content" | "primary";

export interface SourceResolution {
  locale: string;
  reason: SourceReason;
  /** A detection that disagrees with the decision, for the trace. Null when none or agreeing. */
  disputedBy: string | null;
}

export interface SourceInput {
  primaryLocale: string;
  /** `translatableContent[].locale` as Shopify reported it, if any. */
  shopifyContentLocale: string | null;
  /** `translation_source_override.source_locale`, when a person set one. */
  override: string | null;
  /** `translation_source_override.detected_locale`, a suggestion. */
  detected: string | null;
}

export function resolveSourceLocale(input: SourceInput): SourceResolution {
  let locale: string;
  let reason: SourceReason;
  if (input.override && input.override.trim() !== "") {
    locale = input.override;
    reason = "override";
  } else if (
    input.shopifyContentLocale &&
    input.shopifyContentLocale.trim() !== "" &&
    input.shopifyContentLocale !== input.primaryLocale
  ) {
    locale = input.shopifyContentLocale;
    reason = "shopify_content";
  } else {
    locale = input.primaryLocale;
    reason = "primary";
  }
  const disputedBy =
    input.detected && !sameLanguage(input.detected, locale) ? input.detected : null;
  return { locale, reason, disputedBy };
}
