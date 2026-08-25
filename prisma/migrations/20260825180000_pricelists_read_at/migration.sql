-- When the pricelist register was last read, as opposed to when a code was
-- last seen on a priced product. A read that finds nothing touches no
-- metakocka_pricelist row, so there was no way to tell "not read yet" from
-- "read, and everything the merchant had is gone".
ALTER TABLE "shop" ADD COLUMN "pricelists_read_at" TIMESTAMP(3);
