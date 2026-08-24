# MetaKocka fixtures

`warehouse_list.json` is a **recorded** response from a real MetaKocka company
(CLAUDE.md section 12), captured once through `warehouse_list`, which is
read-only. Street, post, place and country are replaced with `REDACTED`: they are
company address data and no parser depends on them.

What the recording confirmed, against the documented example:

- every value is a string, including booleans (`"true"`) and `opr_code` (`"0"`)
- the response carries `opr_time_no_lock_ms` and `doc_type`, which the docs do
  not show, so response schemas stay `passthrough`
- `show_product_free_stock` and `default_microloc_id` are absent entirely, and
  `country` appears on some warehouses and not others, so field presence varies
  per record and optional fields must stay optional

Still to record during the section 14 verification: `put_document`,
`product_add`, `warehouse_stock`, and the exact error payload for a
profit_center that does not exist.
