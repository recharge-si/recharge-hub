-- Two write jobs of a split order could both find the partner unresolved and
-- each create one in MetaKocka. The claim makes resolution single-flight; the
-- loser retries and finds the id already stored.

-- AlterTable
ALTER TABLE "order" ADD COLUMN "metakocka_partner_claimed_at" TIMESTAMP(3);
