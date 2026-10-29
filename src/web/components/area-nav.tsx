/**
 * The tab row of an area with sub-pages (docs/ui-conventions.md § Polaris web
 * components): the current page drawn as the pressed button, the others as
 * quiet buttons with an address, so each is still a place. One component for
 * every area — Translations, Product setup, Sources — so they cannot drift.
 */
export interface AreaNavItem {
  key: string;
  label: string;
  href: string;
}

export function AreaNav({
  items,
  current,
  label,
}: {
  items: readonly AreaNavItem[];
  current: string;
  /** The navigation landmark's accessible name, e.g. "Sources sections". */
  label: string;
}) {
  return (
    <s-box
      paddingBlockEnd="small-300"
      borderWidth="none none small none"
      borderStyle="none none solid none"
      borderColor="subdued"
      accessibilityRole="navigation"
      accessibilityLabel={label}
    >
      <s-stack direction="inline" gap="small-400" alignItems="center">
        {items.map((item) =>
          item.key === current ? (
            <s-button
              key={item.key}
              variant="secondary"
              aria-current="page"
              accessibilityLabel={`${item.label}, current section`}
            >
              {item.label}
            </s-button>
          ) : (
            <s-button key={item.key} variant="tertiary" href={item.href}>
              {item.label}
            </s-button>
          ),
        )}
      </s-stack>
    </s-box>
  );
}
