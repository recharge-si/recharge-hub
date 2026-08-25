/**
 * MetaKocka endpoint paths, relative to `METAKOCKA_BASE_URL`.
 *
 * The API is not consistent about the `json/` segment, and the two families are
 * mutually exclusive: an endpoint answers on one path and returns an HTML 404 on
 * the other. There is no fallback to be clever about, and no rule to derive it
 * from, so every endpoint is listed here explicitly.
 *
 * Probed against a live company on 2026-08-24:
 *
 *   json/warehouse_list    200      warehouse_list    404 HTML
 *   json/warehouse_stock   200      warehouse_stock   404 HTML
 *   json/product_list      200      product_list      404 HTML
 *   json/put_document      404 HTML put_document      200
 *   json/get_document      404 HTML get_document      200
 *   json/delete_document   404 HTML delete_document   200
 *
 * The documentation reflects this split too: `warehouse_list.md` gives the URL
 * with `json/`, `documents_put_document_sales_order.md` gives it without.
 *
 * Add a new endpoint only after probing which path it answers on.
 */
export const ENDPOINTS = {
  warehouseList: "json/warehouse_list",
  warehouseStock: "json/warehouse_stock",
  productList: "json/product_list",
  // Documented as https://main.metakocka.si/rest/eshop/v1/json/product_add and
  // .../json/product_update, the same family as the probed `json/product_list`.
  // Taken from the docs rather than a live probe: confirm on the test company
  // before the first production write.
  productAdd: "json/product_add",
  productUpdate: "json/product_update",
  putDocument: "put_document",
  // Probed 2026-08-25: both answer on the no-json family, like put_document.
  getPartner: "get_partner",
  addPartner: "add_partner",
  getDocument: "get_document",
  deleteDocument: "delete_document",
} as const;

export type EndpointName = keyof typeof ENDPOINTS;
export type EndpointPath = (typeof ENDPOINTS)[EndpointName];
