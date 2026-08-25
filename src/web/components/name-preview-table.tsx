import type { PreviewRow, PreviewStatus } from "~/domain/products/template";

/**
 * What a name pattern would do to products the merchant actually has.
 *
 * Every row is real: the SKU, the name MetaKocka holds now, and the name this
 * pattern produces. Nothing here is generated to fill the table
 * (`docs/ui-conventions.md`), so a shop with an empty catalogue gets a sentence
 * saying so rather than a demonstration built from an invented T-shirt.
 *
 * `s-table` in its default `auto` variant is a table on a wide screen and a
 * list on a narrow one, which is what keeps this readable at 375 px without a
 * horizontal scrollbar (CLAUDE.md 2.6).
 *
 * Status is a word, not a colour. "Unchanged" is the normal outcome and colour
 * marks exceptions only, so no row here is tinted.
 */

const STATUS_LABEL: Record<PreviewStatus, string> = {
  unchanged: "Unchanged",
  changed: "Renamed",
  new: "Created",
  unknown: "Not read yet",
};

const STATUS_HINT: Record<PreviewStatus, string> = {
  unchanged: "",
  changed: "",
  new: "MetaKocka has no product with this SKU.",
  unknown: "Match products with MetaKocka to see the current name.",
};

export interface NamePreviewTableProps {
  rows: PreviewRow[];
  /** Shown when there is nothing to preview. */
  empty: string;
}

export function NamePreviewTable({ rows, empty }: NamePreviewTableProps) {
  if (rows.length === 0) {
    return <s-text color="subdued">{empty}</s-text>;
  }

  return (
    <s-table>
      <s-table-header-row slot="headers">
        <s-table-header listSlot="kicker">SKU</s-table-header>
        <s-table-header listSlot="labeled">Now</s-table-header>
        <s-table-header listSlot="primary">After</s-table-header>
        <s-table-header listSlot="secondary">Change</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {rows.map((row) => (
          <s-table-row key={row.sku}>
            <s-table-cell>
              <s-text color="subdued">{row.sku}</s-text>
            </s-table-cell>
            <s-table-cell>
              {row.currentName ? (
                <s-text>{row.currentName}</s-text>
              ) : (
                <s-text color="subdued">
                  {row.status === "new" ? "No product yet" : "Not recorded"}
                </s-text>
              )}
            </s-table-cell>
            <s-table-cell>
              <s-text>{row.nextName}</s-text>
            </s-table-cell>
            <s-table-cell>
              <s-stack direction="block" gap="small-500">
                <s-text color="subdued">{STATUS_LABEL[row.status]}</s-text>
                {STATUS_HINT[row.status] ? (
                  <s-text color="subdued">{STATUS_HINT[row.status]}</s-text>
                ) : null}
              </s-stack>
            </s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}
