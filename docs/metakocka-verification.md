# MetaKocka verification record

This is the canonical record of MetaKocka behavior observed against designated
test company `6789` on 24–25 August 2026. Product requirements belong in
`docs/BUILD_SPEC.md`; current implementation gaps belong in
`docs/project-status.md`.

Never run these probes against a production company. A new live probe requires
explicit human approval, must use the designated test company, and must record a
sanitized response under `tests/fixtures/metakocka/` before code depends on it.

## Verified summary

| Area              | Observed behavior                                                               | Consequence                                                   |
| ----------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Stock reservation | Sales-order creation leaves `amount` unchanged and increases `reserved_amount`  | Publish `amount` to Shopify `on_hand`                         |
| Document identity | Duplicate `count_code` creates another document                                 | The app's pre-write database claim is the duplicate guard     |
| Split reference   | `buyer_order` is stored/searchable; `customer_order` is discarded               | Sibling documents share `buyer_order`                         |
| Warehouse         | An unknown mark succeeds and falls back to the default warehouse                | Validate cached warehouse identity before every write         |
| Document date     | `dd.mm.yyyy` works; ISO works only with literal `+02:00`                        | Use dotted date in the ERP timezone                           |
| Catalogue line    | Unknown code is rejected unless `unit` is sent, which creates a product         | Never send `unit` or a manual name on order lines             |
| Tax               | MetaKocka does not infer tax; zero is accepted even when financially wrong      | Always send a derived/configured factor; never guess silently |
| Pricelist         | A pricelist has its own fixed net/gross basis                                   | Convert the amount, not only the field name                   |
| Partner           | Inline partner data creates duplicates; an id alone lacks an address            | Resolve/create once, then reference partner and address ids   |
| Document update   | Update behaves as replacement; omitted lines disappear                          | Replay a complete recorded body and read it back              |
| Payment types     | Invalid `payment_type` returns the accepted value set                           | Discover/cache the register from the rejection                |
| Stock write       | `sync_stock` removes omitted products and can report success for an empty no-op | Send and verify a complete warehouse list                     |
| Read-back         | `get_document` has no sales-order status or tracking field                      | Tracking design remains blocked on another source             |

## Inventory reservation

Product `25AC086SG` in warehouse `glavno`, before and after a sales order for two
units:

| Field             | Before | After |
| ----------------- | -----: | ----: |
| `amount`          |     10 |    10 |
| `reserved_amount` |      0 |     2 |
| `free_amount`     |     10 |     8 |

Sales-order creation reserves stock without reducing physical stock. Shopify
already computes available from on-hand and committed quantities, so copying
`free_amount` would double-count the reservation.

`warehouse_stock` returns `stock_list`, includes `amount`, `reserved_amount`,
and `free_amount` without an extra flag, and filters `product_code_list` by the
product's `code` rather than internal `count_code`.

## Sales-order identity and routing

### `count_code` is not unique

Resending an existing external `count_code` succeeded and created a second
document under MetaKocka's own numbering. A timeout or connection reset after
`put_document` must therefore be treated as “may have succeeded” and resolved
by lookup; a blind retry can create a second accounting document.

### `buyer_order` links sibling documents

When both fields were sent, `buyer_order` persisted and was searchable while
`customer_order` was absent. Every document from one Shopify order must share
the deterministic `buyer_order` reference.

The response shape when several documents share one `buyer_order`, and exact
`search` behavior by `count_code`, remain unverified.

### Unknown warehouses silently fall back

Sending a warehouse mark that does not exist returned success and filed the
document against the company default. In contrast, an unknown profit centre
was rejected:

```json
{
  "opr_code": "6",
  "opr_desc": "Profit center 'ThisProfitCenterDoesNotExist' doesn't exist."
}
```

The warehouse list is therefore an identity/safety register, not only UI data.

### Date format

A guaranteed-invalid profit centre was used as a non-writing control: reaching
the profit-centre error proves the date passed validation.

| `doc_date`                                               | Result   |
| -------------------------------------------------------- | -------- |
| `25.08.2026`, `15.01.2026`                               | accepted |
| `2026-08-25+02:00`, including winter dates with `+02:00` | accepted |
| bare `2026-08-25`                                        | rejected |
| `+00:00`, `-04:00`, `+01:00`, `+03:00`                   | rejected |
| `+0200` or a full timestamp                              | rejected |

`+02:00` behaves as a literal, not a real timezone offset: winter `+01:00` was
rejected while winter `+02:00` passed. The implementation uses `dd.mm.yyyy`
with the calendar date in `Europe/Ljubljana`.

## Product lines, tax, and pricelists

### Order lines reference the catalogue

An unknown product code returned `opr_code 8` with an instruction to set `unit`
to add the product. Sending `unit` would turn an order line into an implicit
catalogue write. Existing product lines came back with MetaKocka's catalogue
name, not the name supplied by the app. Order document lines deliberately omit
both `unit` and `name`.

### Tax is mandatory and is not inferred

For a product priced gross at 209 with a 22% rate:

| Input                | Observed result                                               |
| -------------------- | ------------------------------------------------------------- |
| no `tax_factor`      | rejected because the product tax attribute was required       |
| `tax_factor: "0"`    | accepted as 209 net at 0%, financially wrong for this product |
| `tax_factor: "0.22"` | 171.31 net, 209 gross, tax code EX4                           |

MetaKocka did not infer the rate from the product/pricelist. The app uses Shopify
line tax data when present, zero only for explicitly non-taxable lines, and the
merchant's configured default when a taxable Shopify line has no rate.

### Pricelist basis belongs to MetaKocka

Pricelist `1` in the test company is net. Sending `price_with_tax` was rejected
with an instruction to use `price`; sending the gross amount under the net field
would have been accepted as the wrong net price. The amount must be restated on
the pricelist's basis with integer-minor-unit arithmetic.

Additional observations:

- `product_list` omits `pricelist` unless `return_pricelist: "true"` is sent.
- UI-created products have an internal `count_code`; matching uses product
  `code`, and updates use `mk_id`.
- `sales_pricelist_code` persists on a sales order and records which catalogue
  pricing applied.

## Partners

Sending inline customer/address data created another partner instead of matching
an existing one. Resolution must search first and call `add_partner` only when
no acceptable match exists.

`partner: { mk_id }` alone was rejected because MetaKocka also required
`mk_address_id` or address data. A resolved document reference includes partner
and billing-address ids. `add_partner` returned its new identifiers without an
`opr_code`; the shared client treats an absent code as success for endpoints
with that response shape.

The current last-resort name-only matching ambiguity is a product decision in
`docs/project-status.md`.

## Documents and payments

### `get_document`

The request key is `doc_id`, even though `put_document` names the returned value
`mk_id`. The response is the whole document at the top level, including
`product_list`, totals, partner, warehouse, pricelist, and dates. No sales-order
status or tracking field was present.

Asking for a deleted document returned `opr_code 2` with a “cannot find
document” description. Documents previously written by the app had in fact
been deleted through the MetaKocka UI, which is why the worker reads them back
and raises rather than silently recreating them.

### Updates replace the document

A follow-up `put_document` containing an id, date, partner, and `mark_paid` but
omitting `product_list` returned success and removed every line and total. The
API behaves as full replacement, not patch. The current payment and edit paths
replay the stored complete request and verify lines afterward.

That a complete replay preserves every field is strongly inferred and used by
the implementation, but a controlled multi-line replay/payment-survival probe
is still outstanding.

### Payment types

`payment_type` accepts the register's value column, not its description. An
invalid sentinel returned the complete accepted set without creating a
document. Some accepted values can still be rejected by later business rules;
cash/card values in the test company required fiscal cash registers.

`opr_code 6` is therefore a general business rejection, not a unique
profit-centre code. Error classification reads `opr_desc`.

## Endpoints and wire format

The wrong family returns an HTML 404 rather than a JSON error:

| Path family               | Verified endpoints                                               |
| ------------------------- | ---------------------------------------------------------------- |
| `/rest/eshop/v1/json/...` | `warehouse_list`, `warehouse_stock`, `product_list`              |
| `/rest/eshop/v1/...`      | `put_document`, `get_document`, `delete_document`, partner calls |
| `/rest/eshop/sync_stock`  | stock write only                                                 |

Values commonly arrive as strings, including booleans and `opr_code`. Optional
fields vary by record; response schemas intentionally pass through unknown
fields after validating what the app consumes.

Observed operation codes are contextual rather than a reliable enum:

| Code | Observed examples                                                                | Classification                                                               |
| ---- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `0`  | success                                                                          | success                                                                      |
| `2`  | malformed/missing data, no partner match, unknown document, invalid payment type | inspect description; business exception unless explicitly handled as absence |
| `6`  | missing profit centre, fiscal-register rule, invalid date                        | business rejection; inspect description                                      |
| `8`  | product code not in catalogue                                                    | SKU business exception                                                       |

Single-line `put_document` without invoice creation took roughly 73–141 ms of
reported server time and 91–372 ms wall time. Realistic line counts and
`create_invoice: true` remain unmeasured.

## `sync_stock`

- Endpoint: `/rest/eshop/sync_stock`, outside both v1 families.
- Requires `api_user_email` in addition to company id and secret key.
- Products omitted from `stock_list` are removed from the warehouse snapshot.
- A request with no `stock_list` returned success while changing nothing.

The adapter refuses an empty write, echoes unmanaged values unchanged, sends a
complete list, classifies HTTP/non-JSON failures, and verifies returned product
codes and amounts when MetaKocka echoes them.

## Outstanding approved-test-company work

1. Two documents sharing one `buyer_order`, with and without
   `show_split_orders`.
2. Exact `search` response for a known `count_code`.
3. Realistic and invoice-enabled `put_document` timing.
4. Public stock-webhook registration and acknowledgement.
5. Full product pricelist write including `lowest_price_30_days`.
6. Complete multi-line update with and without `mark_paid`, proving payment and
   line survival.
7. Shipping service-line, document `discount_value`, and per-line `discount`
   semantics.

## Known test-company artifacts

The 24 August probe reported several `CLAUDE-VERIFY-*` sales orders and one test
partner left in company `6789`; later probes deleted some other temporary
documents. Their current presence has not been rechecked. Do not assume the test
company is clean, and do not delete anything without first resolving the exact
test-company target and confirming it is verification data. Historical ids are
available in Git if a cleanup is explicitly authorized.
