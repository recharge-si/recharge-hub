-- CreateTable
CREATE TABLE "metakocka_credential" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "secret_key_encrypted" TEXT NOT NULL,
    "webhook_client_secret_encrypted" TEXT,
    "last_verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metakocka_credential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "metakocka_credential_shop_id_key" ON "metakocka_credential"("shop_id");

-- AddForeignKey
ALTER TABLE "metakocka_credential" ADD CONSTRAINT "metakocka_credential_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

