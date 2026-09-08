-- Appointments table backing POST /v1/appointments and the
-- cancel/reschedule endpoints. idempotency_key has a unique constraint so
-- repeated requests with the same Idempotency-Key header return the
-- original row instead of creating a duplicate appointment.
CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'requested',
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT,
  notes TEXT,
  source TEXT,
  metadata JSONB,
  provider_event_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS appointments_account_id_idx ON appointments (account_id);
