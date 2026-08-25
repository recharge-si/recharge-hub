-- Staleness in the other direction: a document deleted or edited in MetaKocka
-- after this app wrote it. Verified against company 6789 on 2026-08-25, where
-- two of four documents recorded as written had been deleted in the ERP and
-- nothing here would ever have found out.

-- AlterEnum
ALTER TYPE "exception_kind" ADD VALUE IF NOT EXISTS 'metakocka_document_missing';
ALTER TYPE "exception_kind" ADD VALUE IF NOT EXISTS 'metakocka_document_changed';
