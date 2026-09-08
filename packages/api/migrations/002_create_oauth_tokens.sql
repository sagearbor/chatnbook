-- OAuth calendar tokens (Google/Microsoft), one row per (account_id,
-- provider). Access/refresh tokens are stored encrypted (AES-256-GCM, key
-- from TOKEN_ENCRYPTION_KEY) by the application before insert -- this
-- table never sees plaintext tokens.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  scope TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, provider)
);
