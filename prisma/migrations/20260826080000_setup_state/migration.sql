-- Guided setup's own state, kept apart from whether the integration works.
--
-- `setup_completed_at` is the activation boundary: the two writers that reach
-- MetaKocka refuse until a person has pressed Finish setup. `setup_step` is
-- where the wizard left off, so closing the tab does not mean starting again.
--
-- Neither decides whether the shop is configured. `domain/readiness` answers
-- that from the configuration itself, and Finish setup refuses while readiness
-- disagrees.

ALTER TABLE "shop" ADD COLUMN "setup_completed_at" TIMESTAMP(3);
ALTER TABLE "shop" ADD COLUMN "setup_step" TEXT;

-- Every shop that already holds MetaKocka credentials was already
-- synchronizing before this column existed, and a merchant who configured this
-- app months ago must not have their orders stop because a new flag defaulted
-- to null. Their install date is the honest value: it is when they activated,
-- as far as anything recorded can tell.
--
-- Deliberately keyed on the credential rather than on the shop row, so a shop
-- that installed the app and never connected still gets the guided setup.
UPDATE "shop" s
SET "setup_completed_at" = s."installed_at"
WHERE EXISTS (
  SELECT 1 FROM "metakocka_credential" c WHERE c."shop_id" = s."id"
);
