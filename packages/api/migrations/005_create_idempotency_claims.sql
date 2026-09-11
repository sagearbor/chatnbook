-- Backs the DB-level guard against two concurrent *first* requests with
-- the same Idempotency-Key header (see src/index.ts's POST /v1/appointments
-- handler and repositories/appointments-repo.ts's tryClaim/releaseClaim).
-- Whichever request's INSERT here wins the unique constraint on
-- idempotency_key proceeds to do the (expensive, side-effecting) calendar
-- work and create the appointment row; the other polls
-- appointments.idempotency_key for the winner's row instead of duplicating
-- it (and, previously, instead of duplicating a real calendar event).
CREATE TABLE IF NOT EXISTS idempotency_claims (
  idempotency_key TEXT PRIMARY KEY,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
