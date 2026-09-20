import {
  TRANSLATIONS_SECTIONS,
  type TranslationsSection,
} from "~/web/lib/translations";

/**
 * The Translations area's own navigation: six destinations, always visible,
 * the current one stated rather than linked (docs/translations.md § Screens).
 * The same shape as product setup's, because two areas with sections should
 * read the same way.
 */
export function TranslationsNav({ current }: { current: TranslationsSection }) {
  return (
    <s-box
      paddingBlockEnd="small-300"
      borderWidth="none none small none"
      borderStyle="none none solid none"
      borderColor="subdued"
      accessibilityRole="navigation"
      accessibilityLabel="Translations sections"
    >
      <s-stack direction="inline" gap="large" alignItems="center">
        {TRANSLATIONS_SECTIONS.map((section) =>
          section.key === current ? (
            <s-text key={section.key} type="strong">
              {section.label}
            </s-text>
          ) : (
            <s-link key={section.key} href={section.href}>
              {section.label}
            </s-link>
          ),
        )}
      </s-stack>
    </s-box>
  );
}
