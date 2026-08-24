-- CreateTable
CREATE TABLE "idempotency_key" (
    "id" TEXT NOT NULL,
    "shop_domain" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idempotency_key_first_seen_at_idx" ON "idempotency_key"("first_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_key_shop_domain_scope_key_key" ON "idempotency_key"("shop_domain", "scope", "key");

