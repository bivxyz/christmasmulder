-- Nov 2026: no email after all (Email Sending needs the Workers paid plan). Invite links make the
-- account directly, and each member gets a personal sign-in link for other phones.
DROP INDEX IF EXISTS members_email;
ALTER TABLE members DROP COLUMN email;
DROP TABLE IF EXISTS login_tokens;
DROP TABLE IF EXISTS email_log;

ALTER TABLE members ADD COLUMN key_hash TEXT;   -- SHA-256 of their personal sign-in link; a new link replaces it
CREATE UNIQUE INDEX IF NOT EXISTS members_key ON members (key_hash) WHERE key_hash IS NOT NULL;

-- for the 10-new-accounts-per-hour limit per IP
CREATE TABLE IF NOT EXISTS join_log (
  ip TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS join_log_ip ON join_log (ip, at);
