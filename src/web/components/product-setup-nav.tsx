import {
  PRODUCT_SETUP_SECTIONS,
  type ProductSetupSection,
} from "~/web/lib/attributes";

/**
 * Product setup's own navigation: five destinations, always visible, the
 * current one stated rather than linked (docs/attributes.md § Screens).
 * Links, not buttons, because these are places. Product types goes to the
 * bare tree; a type is a dialog over it, not a place to return to.
 */
export function ProductSetupNav({ current }: { current: ProductSetupSection }) {
  return (
    /*
     * A row of tabs, the way the admin's own index pages switch views: the
     * current section drawn as the pressed one, the others as quiet
     * buttons. Buttons with addresses, so each is still a place.
     */
    <s-box
      paddingBlockEnd="small-300"
      borderWidth="none none small none"
      borderStyle="none none solid none"
      borderColor="subdued"
      accessibilityRole="navigation"
      accessibilityLabel="Product setup sections"
    >
      <s-stack direction="inline" gap="small-400" alignItems="center">
        {PRODUCT_SETUP_SECTIONS.map((section) =>
          section.key === current ? (
            <s-button
              key={section.key}
              variant="secondary"
              accessibilityLabel={`${section.label}, current section`}
            >
              {section.label}
            </s-button>
          ) : (
            <s-button key={section.key} variant="tertiary" href={section.href}>
              {section.label}
            </s-button>
          ),
        )}
      </s-stack>
    </s-box>
  );
}
