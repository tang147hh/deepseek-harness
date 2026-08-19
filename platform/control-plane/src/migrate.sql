-- Identity schema (plate B). Safe to re-run on an existing Postgres volume.
-- Plate A created no tables; IF NOT EXISTS keeps a used data/postgres dir compatible.

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL,
  email TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_username_key UNIQUE (username),
  CONSTRAINT users_role_check CHECK (role IN ('user', 'admin')),
  CONSTRAINT users_status_check CHECK (status IN ('active', 'disabled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx
  ON users (lower(username));

CREATE TABLE IF NOT EXISTS invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL,
  created_by UUID REFERENCES users (id),
  used_by UUID REFERENCES users (id),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT invites_code_key UNIQUE (code)
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sessions_token_hash_key UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

-- Published static sites (plate G). Safe to re-run on an existing volume.
CREATE TABLE IF NOT EXISTS sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  status TEXT NOT NULL,
  current_version INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sites_slug_key UNIQUE (slug),
  CONSTRAINT sites_status_check CHECK (status IN ('draft', 'live', 'taken_down'))
);

CREATE INDEX IF NOT EXISTS sites_user_id_idx ON sites (user_id);

CREATE TABLE IF NOT EXISTS site_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  bytes BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT site_versions_site_version_key UNIQUE (site_id, version),
  CONSTRAINT site_versions_version_check CHECK (version >= 1),
  CONSTRAINT site_versions_bytes_check CHECK (bytes >= 0)
);

CREATE INDEX IF NOT EXISTS site_versions_site_id_idx ON site_versions (site_id);

-- Site write token + public JSON KV (plate H). Hash only; plaintext is never stored.
-- Safe to re-run on an existing volume (ADD COLUMN / CREATE IF NOT EXISTS).
ALTER TABLE sites ADD COLUMN IF NOT EXISTS write_token_hash TEXT;

CREATE TABLE IF NOT EXISTS site_kv (
  site_id UUID NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT site_kv_pkey PRIMARY KEY (site_id, key),
  CONSTRAINT site_kv_key_check CHECK (key ~ '^[A-Za-z0-9._-]{1,64}$')
);

CREATE INDEX IF NOT EXISTS site_kv_site_id_idx ON site_kv (site_id);
