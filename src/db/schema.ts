export const INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS rulesets (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  version TEXT NOT NULL,
  eligible_for_leaderboard INTEGER NOT NULL DEFAULT 1 CHECK (eligible_for_leaderboard IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (game_id, version),
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS game_players (
  game_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (game_id, player_id),
  UNIQUE (game_id, display_name),
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  ruleset_version TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score >= 0),
  jumps INTEGER NOT NULL CHECK (jumps >= 0),
  near_misses INTEGER NOT NULL CHECK (near_misses >= 0),
  highest_combo INTEGER NOT NULL CHECK (highest_combo >= 1),
  run_seed INTEGER NOT NULL,
  run_duration REAL NOT NULL CHECK (run_duration >= 0),
  game_build_version TEXT NOT NULL,
  run_mode TEXT NOT NULL CHECK (run_mode IN ('normal', 'tutorial', 'practice', 'debug', 'assisted')),
  client_completed_at INTEGER NOT NULL,
  server_received_at INTEGER NOT NULL DEFAULT (unixepoch()),
  verification_status TEXT NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'accepted', 'rejected')),
  power_up_types_collected TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(power_up_types_collected)),
  power_up_collection_counts TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(power_up_collection_counts)),
  power_up_activation_counts TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(power_up_activation_counts)),
  shield_breaks INTEGER NOT NULL DEFAULT 0 CHECK (shield_breaks >= 0),
  double_gum_boosted_jumps INTEGER NOT NULL DEFAULT 0 CHECK (double_gum_boosted_jumps >= 0),
  jump_score_points INTEGER NOT NULL DEFAULT 0 CHECK (jump_score_points >= 0),
  double_gum_bonus_points INTEGER NOT NULL DEFAULT 0 CHECK (double_gum_bonus_points >= 0),
  golden_treat_bonus_points INTEGER NOT NULL DEFAULT 0 CHECK (golden_treat_bonus_points >= 0),
  UNIQUE (game_id, run_id),
  FOREIGN KEY (game_id, player_id) REFERENCES game_players(game_id, player_id) ON DELETE CASCADE,
  FOREIGN KEY (game_id, ruleset_version) REFERENCES rulesets(game_id, version) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_rulesets_game_eligibility
  ON rulesets (game_id, eligible_for_leaderboard, version);

CREATE INDEX IF NOT EXISTS idx_game_players_player
  ON game_players (player_id, game_id);

CREATE INDEX IF NOT EXISTS idx_runs_game_player_receipt
  ON runs (game_id, player_id, server_received_at DESC);

CREATE INDEX IF NOT EXISTS idx_runs_receipt
  ON runs (server_received_at DESC);

CREATE INDEX IF NOT EXISTS idx_runs_leaderboard_order
  ON runs (game_id, ruleset_version, score DESC, server_received_at ASC)
  WHERE verification_status = 'accepted';

CREATE TABLE IF NOT EXISTS request_limits (
  scope TEXT NOT NULL,
  subject TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 0),
  PRIMARY KEY (scope, subject)
);

CREATE INDEX IF NOT EXISTS idx_request_limits_window
  ON request_limits (window_started_at);
`;
