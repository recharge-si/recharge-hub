-- A spreadsheet of attribute values read and waiting to be applied, or being
-- applied (docs/attributes.md § Bulk values). Additive: a new table.

-- CreateTable
CREATE TABLE "bulk_value_import" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "created_by" TEXT,
    "status" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "summary" JSONB NOT NULL,
    "changes" JSONB NOT NULL,
    "outcomes" JSONB NOT NULL DEFAULT '[]',
    "total" INTEGER NOT NULL DEFAULT 0,
    "done" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "applied_by" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bulk_value_import_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bulk_value_import_shop_id_created_at_idx" ON "bulk_value_import"("shop_id", "created_at");

-- AddForeignKey
ALTER TABLE "bulk_value_import" ADD CONSTRAINT "bulk_value_import_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
