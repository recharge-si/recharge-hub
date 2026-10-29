import { AreaNav } from "~/web/components/area-nav";
import {
  TRANSLATIONS_SECTIONS,
  type TranslationsSection,
} from "~/web/lib/translations";

/**
 * The Translations area's own navigation: always visible, the current one
 * stated rather than linked (docs/translations.md § Screens). The same
 * component as every other area's (`AreaNav`).
 */
export function TranslationsNav({ current }: { current: TranslationsSection }) {
  return (
    <AreaNav
      items={TRANSLATIONS_SECTIONS}
      current={current}
      label="Translations sections"
    />
  );
}
