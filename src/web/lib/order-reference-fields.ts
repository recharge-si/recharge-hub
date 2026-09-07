import {
  pickerRows,
  type FieldDef,
  type PickerGroup,
} from "~/domain/products/template";
import {
  ORDER_REFERENCE_PLACEHOLDERS,
  renderOrderReference,
  type OrderReferenceContext,
} from "~/domain/orders/reference";

/**
 * The order reference, as the pattern editor sees it.
 *
 * The editor is written about a pattern rather than about a product: it knows
 * the `{field}` syntax, the chips and the keyboard, and it asks whoever hosts
 * it what the fields are and what they come to. This is that answer for the
 * order reference, and it is the whole of what makes the reference pattern the
 * same control as the product name pattern.
 *
 * Presentation glue, which is why it lives here: the fields and the rendering
 * are the orders domain's, the picker's shapes are the template engine's, and
 * neither has any business importing the other.
 */

/** Every field an order reference can be built from, for the chips and the list. */
export const ORDER_REFERENCE_REGISTRY: FieldDef[] =
  ORDER_REFERENCE_PLACEHOLDERS.map((placeholder) => ({
    id: placeholder.token,
    label: placeholder.label,
    // The picker's own grouping is about products. These four are one group.
    group: "product",
  }));

/**
 * The fields to offer for what is being typed, each showing what it comes to
 * for one of the merchant's own orders.
 *
 * Resolved through `renderOrderReference` rather than a second copy of the
 * field table, so the row a merchant reads and the reference an order is filed
 * under can never disagree. A shop with no orders yet gets the field names and
 * no invented example (docs/ui-conventions.md: sample data is the merchant's
 * own or there is none).
 */
export function orderReferenceRows(
  query: string,
  sample: OrderReferenceContext | null,
): PickerGroup[] {
  const rows = pickerRows(ORDER_REFERENCE_REGISTRY, query, (fieldId) => {
    if (!sample) return null;
    // A field the sample cannot answer — a customer email this app does not
    // keep — shows nothing rather than an empty string, which would read as
    // "this order has none".
    return renderOrderReference(`{${fieldId}}`, sample) || null;
  });

  return rows.length > 0 ? [{ id: "order", label: "Order", rows }] : [];
}
