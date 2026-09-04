CREATE TABLE IF NOT EXISTS hearth_ledger (
  id smallint PRIMARY KEY CHECK (id = 1),
  world jsonb NOT NULL CHECK (jsonb_typeof(world) = 'object'),
  constitution_version text NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  migrated_from text NOT NULL,
  migrated_sha256 text NOT NULL CHECK (migrated_sha256 ~ '^[0-9a-f]{64}$'),
  migrated_blob_etag text,
  migrated_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
