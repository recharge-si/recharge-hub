-- A background job that exhausted its retries used to disappear into pg-boss's
-- failed state with nothing telling the merchant. Dead-lettered jobs now raise
-- an exception so the queue going quiet is visible where the work is done.

-- AlterEnum
ALTER TYPE "exception_kind" ADD VALUE IF NOT EXISTS 'job_failed';
