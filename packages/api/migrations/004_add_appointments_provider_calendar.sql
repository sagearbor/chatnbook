-- Adds provider + calendar_id to appointments so cancellation
-- (POST /v1/appointments/:id/cancel, see src/index.ts) knows which
-- calendar connector and calendar to call to delete the real event when
-- one was created. Both are nullable: appointments created without a
-- `provider` (the pre-existing, still-supported path -- see
-- packages/adapters/mcp) leave these null, and cancellation skips
-- calendar work entirely, exactly as before.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS calendar_id TEXT;
