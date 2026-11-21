-- Invite links + email sign-in (Nov 2026). Run once on a database made by the old schema.sql.
-- Every member who existed before this is family.
ALTER TABLE members ADD COLUMN email TEXT;            -- lowercase; never sent to the browser
ALTER TABLE members ADD COLUMN is_family INTEGER NOT NULL DEFAULT 0;
ALTER TABLE members ADD COLUMN invited_by TEXT;       -- member id of whoever's invite link they used
ALTER TABLE members ADD COLUMN created_at TEXT;
UPDATE members SET is_family = 1;
CREATE UNIQUE INDEX IF NOT EXISTS members_email ON members (email) WHERE email IS NOT NULL;

-- one shareable link per family member at a time
CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  max_uses   INTEGER NOT NULL,
  uses       INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT
);

-- one-time sign-in links: only the SHA-256 of the token is stored
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash  TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  member_id   TEXT,            -- set when the link signs in (or adds an email to) an existing member
  invite_code TEXT,            -- set when the link creates a new account
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);

-- for the 5-per-hour limit on sign-in emails
CREATE TABLE IF NOT EXISTS email_log (
  email TEXT NOT NULL,
  ip    TEXT NOT NULL,
  at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS email_log_email ON email_log (email, at);
CREATE INDEX IF NOT EXISTS email_log_ip ON email_log (ip, at);
