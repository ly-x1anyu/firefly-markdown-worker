-- Firefly-Markdown 后端 D1 schema
-- 执行：wrangler d1 execute fmd-db --local --file=./migrations/0001_init.sql
--       wrangler d1 execute fmd-db --remote --file=./migrations/0001_init.sql

CREATE TABLE IF NOT EXISTS sessions (
  token         TEXT PRIMARY KEY,
  github_login  TEXT NOT NULL,
  github_token  TEXT NOT NULL,           -- 已用 SESSION_SECRET(AES-GCM) 加密
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state      TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS site_config (
  key   TEXT PRIMARY KEY,
  value TEXT
);
