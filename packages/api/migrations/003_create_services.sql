-- Backs GET /v1/services and lets /v1/availability honour a serviceId by
-- deriving the slot length from the service's own duration + buffer,
-- instead of trusting an arbitrary client-supplied slotMinutes.
CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  buffer_minutes INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS services_account_id_idx ON services (account_id);
