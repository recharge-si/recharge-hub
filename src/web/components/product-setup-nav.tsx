import {
  PRODUCT_SETUP_SECTIONS,
  type ProductSetupSection,
} from "~/web/lib/attributes";

/**
 * Product setup's own navigation: four destinations, always visible, the
 * current one stated rather than linked (docs/attributes.md § Screens).
 * Links, not buttons, because these are places. Product types goes to the
 * bare tree; a type is a dialog over it, not a place to return to.
 */
export function ProductSetupNav({ current }: { current: ProductSetupSection }) {
  return (
    <s-box
      paddingBlockEnd="small-300"
      borderWidth="none none small none"
      borderStyle="none none solid none"
      borderColor="subdued"
      accessibilityRole="navigation"
      accessibilityLabel="Metafields sections"
    >
      <s-stack direction="inline" gap="large" alignItems="center">
        {PRODUCT_SETUP_SECTIONS.map((section) =>
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
