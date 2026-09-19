-- The attribute schema (docs/attributes.md).
--
-- One document per shop: the tree of product types, the attribute catalogue,
-- the sets, and the rules that attach them. It is edited whole and exported
-- whole, so it is stored whole; `revision` is what a save is conditional on,
-- so two people editing at once get a refused save rather than a silent
-- overwrite.
--
-- Additive: nothing existing is changed or backfilled.

-- CreateTable
CREATE TABLE "attribute_schema" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "document" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attribute_schema_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attribute_schema_shop_id_key" ON "attribute_schema"("shop_id");

-- AddForeignKey
ALTER TABLE "attribute_schema" ADD CONSTRAINT "attribute_schema_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
