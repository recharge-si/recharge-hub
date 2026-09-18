-- The order-transfer switch.
--
-- Until now there was no way to stop orders reaching MetaKocka short of
-- disconnecting the ERP, which also stops stock and the catalogue. A merchant
-- who wants the connector for stock alone, or who is not ready for the ERP to
-- receive orders yet, needs the one switch on its own.
--
--   * `transfer_orders` is the switch. Off is a hard stop: no document is
--     written, updated or paid while it is off. Orders are still received and
--     shown, so nothing is lost.
--
--   * `transfer_orders_since` is the cut-off applied when the switch goes back
--     on without its backlog: an order received before it that has no document
--     is left alone, because it was handled some other way while transfer was
--     off and sending it now would duplicate it. An order MetaKocka already
--     holds is never held back by this. NULL means no cut-off.
--
-- Both default to what every existing shop already has: on, and no cut-off.

-- AlterTable
ALTER TABLE "sales_order_setting"
  ADD COLUMN "transfer_orders" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "transfer_orders_since" TIMESTAMP(3);
