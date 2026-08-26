-- Per-location stock sync outcome.
--
-- The sync job logged one line for the whole run and let one location's failure
-- throw, which killed the sweep and re-ran every location behind it on the next
-- retry. A location that had failed every attempt for nine hours still showed
-- as "Syncing".

-- AlterEnum
ALTER TYPE "exception_kind" ADD VALUE IF NOT EXISTS 'stock_sync_failed';

-- AlterTable
ALTER TABLE "supply_source" ADD COLUMN     "last_sync_at" TIMESTAMP(3),
                            ADD COLUMN     "last_sync_ok" BOOLEAN,
                            ADD COLUMN     "last_sync_message" TEXT,
                            ADD COLUMN     "sync_failures" INTEGER NOT NULL DEFAULT 0;
