CREATE TABLE IF NOT EXISTS run_sessions (
  run_id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  ruleset_version TEXT NOT NULL,
  game_build_version TEXT NOT NULL,
  run_seed INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  nonce TEXT NOT NULL UNIQUE,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'submitted', 'expired', 'rejected')),
  FOREIGN KEY (game_id, player_id) REFERENCES game_players(game_id, player_id) ON DELETE CASCADE,
  FOREIGN KEY (game_id, ruleset_version) REFERENCES rulesets(game_id, version) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_run_sessions_player_issued
  ON run_sessions (game_id, player_id, issued_at DESC);

CREATE INDEX IF NOT EXISTS idx_run_sessions_expiry
  ON run_sessions (status, expires_at);

ALTER TABLE runs ADD COLUMN run_session_id TEXT;
ALTER TABLE runs ADD COLUMN input_trace TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(input_trace));

CREATE INDEX IF NOT EXISTS idx_runs_session
  ON runs (run_session_id);
