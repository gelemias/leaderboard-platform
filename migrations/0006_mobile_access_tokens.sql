CREATE TABLE IF NOT EXISTS mobile_access_tokens (
  token_id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY (game_id, player_id) REFERENCES game_players(game_id, player_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mobile_access_tokens_expiry
  ON mobile_access_tokens (expires_at, revoked_at);

CREATE INDEX IF NOT EXISTS idx_mobile_access_tokens_subject
  ON mobile_access_tokens (game_id, player_id, expires_at);
