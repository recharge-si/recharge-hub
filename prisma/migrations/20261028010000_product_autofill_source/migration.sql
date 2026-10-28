-- Where an autofill suggestion came from and which model made it (additive).
ALTER TABLE "product_autofill" ADD COLUMN "source" TEXT;
ALTER TABLE "product_autofill" ADD COLUMN "model" TEXT;
