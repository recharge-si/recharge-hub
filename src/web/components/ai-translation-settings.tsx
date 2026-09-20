import type {
  LanguageSettings,
  OverwritePolicy,
} from "~/domain/translations/types";
import { ToggleRow } from "~/web/components/toggle-row";

/**
 * The three switches that say what the engine does for one language
 * (docs/translations.md § Data model): whether it works on the language
 * at all, whether new content is translated as it appears, and whether
 * translations it wrote are redone when the source changes.
 *
 * The same rows on Add language and on the language's own page, so the
 * words a merchant chose by are the words they find again. The two
 * automatic rows depend on the first and are disabled, not hidden, while
 * it is off: what turning it on gives is visible without turning it on.
 *
 * The wording is the engine's behaviour, no more: products reach the
 * engine through a webhook within minutes, everything else on the nightly
 * pass; "up to date" means translations the AI itself wrote and nobody has
 * touched since — a person's edit is `manual` to the planner and is left
 * alone unless the language's policy is `overwrite_all`, and the row says
 * which of the two it is.
 */
export type AiTranslationValue = Pick<
  LanguageSettings,
  "aiEnabled" | "autoTranslateNew" | "autoUpdateOutdated"
>;

/**
 * What "up to date" touches follows the planner's `mayOverwrite`: under
 * `protect_existing` nothing already translated is ever revisited, so the
 * switch would do nothing and says so.
 */
const UP_TO_DATE_DESCRIPTION: Record<OverwritePolicy, string> = {
  update_ai_managed:
    "When source text changes, translations the AI wrote are redone. Translations edited by a person are left unchanged.",
  overwrite_all:
    "When source text changes, outdated translations are redone — including translations edited by a person, because this language allows overwriting everything.",
  protect_existing:
    "This language protects every existing translation, so an outdated one is left as it is. Change the policy below to let the AI redo what it wrote.",
};

export function AiTranslationSettings({
  value,
  onChange,
  configured,
  overwritePolicy = "update_ai_managed",
  disabled = false,
}: {
  value: AiTranslationValue;
  onChange: (patch: Partial<AiTranslationValue>) => void;
  /** Whether the server has a provider key; without one nothing runs. */
  configured: boolean;
  /** The language's overwrite policy, which decides what "up to date" may touch. */
  overwritePolicy?: OverwritePolicy;
  disabled?: boolean;
}) {
  const automatic = disabled || !value.aiEnabled;
  return (
    <s-stack direction="block" gap="base">
      <ToggleRow
        label="Enable AI translation"
        description={
          configured
            ? "Let this app translate into this language with AI, on request and automatically as set below."
            : "AI translation is not configured on this server. Settings are kept and take effect once it is."
        }
        checked={value.aiEnabled}
        onChange={(aiEnabled) => onChange({ aiEnabled })}
        disabled={disabled}
      />
      <ToggleRow
        dependent
        label="Translate new content automatically"
        description="Products are translated within minutes of being created or changed. Collections, pages, articles, navigation and metafields are picked up nightly."
        checked={value.autoTranslateNew}
        onChange={(autoTranslateNew) => onChange({ autoTranslateNew })}
        disabled={automatic}
      />
      <ToggleRow
        dependent
        label="Keep AI translations up to date"
        description={UP_TO_DATE_DESCRIPTION[overwritePolicy]}
        checked={value.autoUpdateOutdated}
        onChange={(autoUpdateOutdated) => onChange({ autoUpdateOutdated })}
        disabled={automatic}
      />
    </s-stack>
  );
}
