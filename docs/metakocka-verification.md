# MetaKocka verification results

`docs/BUILD_SPEC.md` section 14 requires these checks against a MetaKocka **test
company** before anything is built on top of them. Run on 2026-08-24 against
test company `6789`. Every claim below is an observed response, not a reading of
the docs.

Where a finding contradicts `docs/BUILD_SPEC.md`, the finding wins and the
section is flagged for correction.

---

## Item 8 — does `amount` drop at sales-order creation? **ANSWERED: no**

This is the one section 7 depends on.

Product `25AC086SG` in warehouse `glavno`, before and after a sales order for 2:

| field | before | after |
|---|---|---|
| `amount` | 10 | **10** |
| `reserved_amount` | 0 | **2** |
| `free_amount` | 10 | 8 |

`amount` is untouched by sales-order creation; the order lands in
`reserved_amount`, and `free_amount` is the difference.

**Section 7 stands as written.** Publish `amount` to Shopify `on_hand`. No
change needed.

---

## Item 2 — a `profit_center` that does not exist. **ANSWERED**

```json
{ "opr_code": "6",
  "opr_desc": "Profit center 'ThisProfitCenterDoesNotExist' doesn't exist." }
```

Recorded in `adapters/metakocka/errors.ts` as a business exception. Note this is
a different code from the generic `"2"` returned for a malformed request.

### Observed `opr_code` values so far

| code | meaning | classification |
|---|---|---|
| `0` | success | — |
| `2` | request not accepted as written: "Partner data are missing", "Cannot find document type sales_order with id = null" | exception |
| `6` | named entity does not exist: profit center | exception |

---

## Finding A — an invalid `warehouse` is silently accepted **(severe)**

Not on the section 14 list, and it should have been.

Sending `"warehouse": "NoSuchWarehouse"` returns `opr_code: "0"` and creates the
document. Reading it back shows `"warehouse": "glavno"` — MetaKocka fell back to
the company default without a word.

MetaKocka validates `profit_center` and does **not** validate `warehouse`. Since
warehouse is the document-level field that decides which supply source fulfils
the order (section 3), a stale or mistyped warehouse mark silently routes stock
out of the wrong place, and nothing in the response says so.

**Consequence for the build:** `supply_source.metakocka_warehouse` must be
validated against `warehouse_list` before any document is sent, and re-validated
when the mapping is edited. We cannot rely on MetaKocka to reject it.

---

## Finding B — `customer_order` is ignored; the field is `buyer_order`

This finding corrects the build specification.

`docs/BUILD_SPEC.md` section 3 and section 8.4 both say `customer_order` links sibling
documents. It does not: the value is silently discarded.

Sent `customer_order: "CUSTOMER-ORDER-VALUE"` and `buyer_order:
"BUYER-ORDER-VALUE"` on the same document. Reading it back:

```
buyer_order      "BUYER-ORDER-VALUE"
customer_order   undefined
```

`get_document` by `buyer_order` finds the document. By `customer_order` it
returns `opr_code 2`.

**Correction needed in `docs/BUILD_SPEC.md` sections 3 and 8.4:** the field is
`buyer_order`, on both write and read. Every sibling document from one Shopify
order shares it, and it is how the split order is found again.

---

## Finding C — duplicate `count_code` creates a second document **(severe)**

Re-sending a `count_code` that already exists does not fail and does not return
the existing document. It creates a **new** document and assigns it MetaKocka's
own numbering:

```
sent      count_code: "CLAUDE-VERIFY-STOCK-1"   (already used)
returned  count_code: "1/2026",  mk_id: 1200049884735
```

So `count_code` is not a unique key on MetaKocka's side, and a retry after an
ambiguous timeout produces a duplicate document that can no longer be found by
the `count_code` we sent.

**Consequence for the build:** the guard in section 8.4 — check
`metakocka_document` for the `count_code` before calling — is not an
optimisation, it is the only thing preventing duplicate sales orders. It must be
written **before** the call and reconciled after, and a timeout must be treated
as "may have succeeded" and resolved by lookup, never by blind retry.

---

## Finding D — endpoint paths are split across two families

Mutually exclusive; the wrong one returns an HTML 404, not a JSON error.

| path | endpoints |
|---|---|
| `/rest/eshop/v1/json/…` | `warehouse_list`, `warehouse_stock`, `product_list` |
| `/rest/eshop/v1/…` | `put_document`, `get_document` |

Recorded in `adapters/metakocka/endpoints.ts`. Probe any new endpoint before use.

---

## Finding E — smaller observations

- Every value is a string, including booleans (`"true"`) and `opr_code` (`"0"`).
- Responses carry `opr_time_no_lock_ms` and `doc_type`, undocumented; schemas
  stay `passthrough`.
- Field presence varies per record: `country`, `show_product_free_stock` and
  `default_microloc_id` appear on some warehouses and not others.
- `warehouse_stock`'s `product_code_list` matches `code`, **not** `count_code`.
- `reserved_amount` and `free_amount` are returned by default; no flag needed.
- `profit_center` defaults to the company setting (`RCH-Web-stock` here) when
  omitted, rather than being empty.
- `get_document` takes `doc_id`, not `mk_id`, even though `put_document` returns
  the identifier as `mk_id`. They are the same value.

### Timings (item 3, partial)

Single-line sales order, no `create_invoice`: **73–141 ms** server time,
91–372 ms wall clock. Nowhere near the ~47 s the docs cite for the
`create_invoice` path. Not yet timed: realistic line counts, and
`create_invoice: true`.

---

## Item 7 — the payment types this company accepts. **ANSWERED**

`payment_type` takes the **Vrednost** column of Nastavitve → Šifranti → Vrsta
plačila, not the Opis column. `debit_card` (an Opis) was rejected; `Kartica BA`
(its Vrednost) was recognised.

Better: an invalid value returns the whole valid set, and creates nothing.

```
opr_code 2
"Paramether 'payment_type' has invalid value : X.
 Valid values : Transakcijski račun,Gotovina,Prenos preplačila,Kartica BA"
```

So the list is discoverable. Confirmed it reaches that validation with a partner
and no product list, and with an empty product list, both rejected before any
document exists.

**Two of the four are currently unusable in this company:**

```
"Gotovina"    -> opr_code 6
"Kartica BA"  -> opr_code 6
  "Plačilni inštrument X, je potrebno davčno potrditi, vendar nimate
   vklopljenih davčnih blagajn."
```

Cash and card need fiscal registers (davčne blagajne) enabled. Only
`Transakcijski račun` succeeded. This blocks mapping a cash-on-delivery gateway
until fiscal registers are switched on, and §8.7 needs to surface it as an
actionable exception rather than a generic failure.

`opr_code 6` therefore covers more than "does not exist": it is a business rule
refusal.

---

## Finding F — `sync_stock` is destructive and reports success when idle

Writing stock back into MetaKocka, for warehouses counted in Shopify.

- Endpoint is `/rest/eshop/sync_stock`. Not under `v1`, not under `json`; both
  of those return an HTML 404.
- Requires `api_user_email` on top of the secret key. An unknown address returns
  `opr_code 6, "Cannot find email '...' for paramether api_user_email"`.
- Documented behaviour: "items previously in stock but omitted from request get
  removed". A partial list wipes the rest of the warehouse.
- **Posting with no `stock_list` at all returned `opr_code 0, "Sync
  successful"`.** Stock was checked immediately afterwards and was untouched, so
  it was a genuine no-op — but a malformed payload is indistinguishable from a
  real sync by the response code alone.

Both hazards are handled in `adapters/metakocka/sync-stock.ts`: the payload
always describes the whole warehouse, an empty list is refused outright, and the
returned `stock_list` is compared against what was sent.


---

## Still outstanding

| item | status |
|---|---|
| 1 — two orders sharing one reference, `show_split_orders` | **partial.** Both documents created; linking now needs re-testing with `buyer_order` (Finding B). `search` was called with wrong parameters and proved nothing. |
| 3 — timing with realistic line counts and `create_invoice` | partial, see above |
| 4 — register the stock webhook, confirm our response is accepted | not started; needs a public URL |
| 5 — push a product with a full pricelist incl. `lowest_price_30_days` | not started |
| 6 — `mark_paid`, then `update_document` without it, confirm survival | not started |
| 7 — list the payment types and exact `payment_type` strings | **done**, see above |

## Test data left in company 6789

Created by this run and safe to delete:

| count_code | mk_id | note |
|---|---|---|
| `CLAUDE-VERIFY-STOCK-1` | 1200049884717 | holds 2 units of `25AC086SG` reserved |
| `CLAUDE-VERIFY-STOCK-2` | 1200049884733 | warehouse `Shopify` |
| `CLAUDE-VERIFY-BADWH` | 1200049884734 | landed in `glavno` despite a bogus warehouse |
| `1/2026` | 1200049884735 | the duplicate-`count_code` document |
| `CLAUDE-VERIFY-REF` | 1200049884744 | the `buyer_order` test |

Also created: partner "Verification Buyer", mk_id 400071663942.
