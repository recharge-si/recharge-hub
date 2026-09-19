import { useEffect, useState } from "react";

import {
  LAST_TYPE_KEY,
  PRODUCT_SETUP_ROUTES,
  PRODUCT_SETUP_SECTIONS,
  type ProductSetupSection,
} from "~/web/lib/attributes";

/**
 * Product setup's own navigation: four destinations, always visible, the
 * current one stated rather than linked (docs/attributes.md § Screens).
 *
 * Links, not buttons, because these are places. The one exception to a
 * plain link is Product types, which goes back to the type last chosen in
 * this browser so leaving for the catalogue and coming back lands where the
 * person was. The remembered id is read after mount so the server and the
 * client render the same markup.
 */
export function ProductSetupNav({ current }: { current: ProductSetupSection }) {
  const [typesHref, setTypesHref] = useState<string>(
    PRODUCT_SETUP_ROUTES.types,
  );

  useEffect(() => {
    try {
      const remembered = window.localStorage.getItem(LAST_TYPE_KEY);
      if (remembered) setTypesHref(PRODUCT_SETUP_ROUTES.type(remembered));
    } catch {
      // Storage can be unavailable; the plain address still works.
    }
  }, []);

  return (
    <s-box
      paddingBlockEnd="small-300"
      borderWidth="none none small none"
      borderStyle="none none solid none"
      borderColor="subdued"
      accessibilityRole="navigation"
      accessibilityLabel="Product setup sections"
    >
      <s-stack direction="inline" gap="large" alignItems="center">
        {PRODUCT_SETUP_SECTIONS.map((section) =>
          section.key === current ? (
            <s-text key={section.key} type="strong">
              {section.label}
            </s-text>
          ) : (
            <s-link
              key={section.key}
              href={section.key === "types" ? typesHref : section.href}
            >
              {section.label}
            </s-link>
          ),
        )}
      </s-stack>
    </s-box>
  );
}

/** Remembers the type a person is looking at, for the nav's Product types link. */
export function rememberType(typeId: string | null): void {
  try {
    if (typeId === null) window.localStorage.removeItem(LAST_TYPE_KEY);
    else window.localStorage.setItem(LAST_TYPE_KEY, typeId);
  } catch {
    // Storage can be unavailable; nothing depends on it.
  }
}

/**
 * Whether the viewport is too narrow for the tree beside the editor. Null
 * until measured on the client, so nothing decides from a guess.
 */
export function useNarrow(maxWidth = 720): boolean | null {
  const [narrow, setNarrow] = useState<boolean | null>(null);
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const apply = () => setNarrow(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [maxWidth]);
  return narrow;
}
