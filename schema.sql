-- christmasmulder D1 schema. Safe to re-run.
CREATE TABLE IF NOT EXISTS members (
  id     TEXT PRIMARY KEY,          -- 'dad', 'dana', ...
  name   TEXT NOT NULL,
  sort   INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1  -- inactive members keep old ratings but can't sign in
);

INSERT OR IGNORE INTO members (id, name, sort, active) VALUES
  ('dad',   'Dad',   1, 1),
  ('dana',  'Dana',  2, 1),
  ('kitty', 'Kitty', 3, 1),
  ('jen',   'Jen',   4, 1),
  ('robin', 'Robin', 5, 1),
  ('lola',  'Lola',  6, 1);

CREATE TABLE IF NOT EXISTS movies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  season        TEXT NOT NULL,         -- '2026' ... '2020', 'classics'
  title_key     TEXT NOT NULL,         -- normalized title; the sync identity
  title         TEXT NOT NULL,
  row_order     INTEGER NOT NULL,      -- row in Chris's tab
  release_date  TEXT,                  -- ISO yyyy-mm-dd
  release_year  INTEGER,
  network       TEXT,                  -- display name
  network_code  TEXT,                  -- what Chris typed
  imdb          REAL,
  rec           TEXT,                  -- DVR status: X, X-W, X-D, N/A ...
  view          TEXT,                  -- S-F, S-FC, S-$, APP
  comment       TEXT,                  -- comment cell + Google comments on the row
  missing_since TEXT,                  -- set when the row disappears from the sheet
  imdb_id       TEXT,
  poster_url    TEXT,                  -- null = placeholder
  poster_checked_at TEXT,              -- null = not looked up yet
  synced_at     TEXT NOT NULL,
  UNIQUE (season, title_key)
);
CREATE INDEX IF NOT EXISTS movies_season ON movies (season, missing_since);

CREATE TABLE IF NOT EXISTS ratings (
  movie_id   INTEGER NOT NULL REFERENCES movies(id),
  member_id  TEXT NOT NULL REFERENCES members(id),
  score      REAL,                     -- 0-10, same scale as IMDB (stars x 2)
  verdict    TEXT,                     -- 'sucks', 'turned-off', 'skipped'
  watched    INTEGER NOT NULL DEFAULT 0,
  source     TEXT NOT NULL,            -- 'sheet' | 'site'; site always wins
  updated_at TEXT NOT NULL,             -- last written (sync bumps this every run)
  rated_at   TEXT,                      -- when the rating itself last changed; null = old sheet rating
  PRIMARY KEY (movie_id, member_id)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- wrong family-code attempts, for a per-IP lockout (the code is short)
CREATE TABLE IF NOT EXISTS login_failures (
  ip TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS login_failures_ip ON login_failures (ip, at);

-- Letterboxd-style favorites: up to 4 per member
CREATE TABLE IF NOT EXISTS favorites (
  member_id  TEXT NOT NULL REFERENCES members(id),
  movie_id   INTEGER NOT NULL REFERENCES movies(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (member_id, movie_id)
);
