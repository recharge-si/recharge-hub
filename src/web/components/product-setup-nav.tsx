import { AreaNav } from "~/web/components/area-nav";
import {
  PRODUCT_SETUP_SECTIONS,
  type ProductSetupSection,
} from "~/web/lib/attributes";

/**
 * Product setup's own navigation: always visible, the current one stated
 * rather than linked (docs/attributes.md § Screens). Links, not buttons,
 * because these are places. Product types goes to the bare tree; a type is a
 * dialog over it, not a place to return to.
 */
export function ProductSetupNav({ current }: { current: ProductSetupSection }) {
  return (
    <AreaNav
      items={PRODUCT_SETUP_SECTIONS}
      current={current}
      label="Product setup sections"
    />
  );
}
