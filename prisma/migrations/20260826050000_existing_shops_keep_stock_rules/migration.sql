-- Existing shops keep the allocation behaviour they already had.
--
-- `sales_order_setting.allocation_mode` defaults to `shopify_locations`, which
-- is the right default for a shop installing this app today: a merchant moving
-- a line between locations in the Shopify admin is stating where it ships from,
-- and the ERP should follow.
--
-- It is the wrong thing to do *to* a shop that is already running. Those shops
-- have MetaKocka documents filed against warehouses this app chose from stock
-- levels, and flipping the authority underneath them would restructure those
-- documents the next time anything unrelated touched the order -- a tag added,
-- a note edited. Nobody asked for that and nobody would see it coming.
--
-- So every shop that exists at this moment is pinned to `stock_rules`, which is
-- exactly what it was doing before the feature existed. Shops created after
-- this migration have no row and inherit the new default. Switching is one
-- control on the Order sync settings page, where the consequence is spelled out
-- before it is saved.
--
-- Additive and idempotent: it inserts only where no row exists, and changes no
-- setting a merchant has already chosen.

INSERT INTO "sales_order_setting" (
  "id",
  "shop_id",
  "allocation_mode",
  "created_at",
  "updated_at"
)
SELECT
  -- cuid-shaped enough to be unique and obviously machine-made; the column is
  -- a plain text primary key with no format constraint.
  'migr_' || replace(gen_random_uuid()::text, '-', ''),
  s."id",
  'stock_rules',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "shop" s
WHERE NOT EXISTS (
  SELECT 1 FROM "sales_order_setting" existing WHERE existing."shop_id" = s."id"
);
