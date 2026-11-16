-- The order watchdog and operator alerts (docs/architecture.md § Schedules
-- and recovery). Additive: one enum value and one nullable column.

-- An order that should be in MetaKocka and is not, with nothing else open on it.
ALTER TYPE "exception_kind" ADD VALUE 'order_not_transferred';

-- When an exception was announced to the operator channel. Null for every
-- existing row, so nothing old is announced.
ALTER TABLE "exception" ADD COLUMN "alerted_at" TIMESTAMP(3);
