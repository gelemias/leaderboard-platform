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
  validator_key TEXT NOT NULL DEFAULT 'generic',
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
  run_session_id TEXT,
  input_trace TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(input_trace)),
  game_stats TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(game_stats)),
  UNIQUE (game_id, run_id),
  FOREIGN KEY (game_id, player_id) REFERENCES game_players(game_id, player_id) ON DELETE CASCADE,
  FOREIGN KEY (game_id, ruleset_version) REFERENCES rulesets(game_id, version) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_rulesets_game_eligibility
  ON rulesets (game_id, eligible_for_leaderboard, version);

CREATE INDEX IF NOT EXISTS idx_rulesets_validator
  ON rulesets (game_id, validator_key, version);

CREATE INDEX IF NOT EXISTS idx_game_players_player
  ON game_players (player_id, game_id);

CREATE INDEX IF NOT EXISTS idx_runs_game_player_receipt
  ON runs (game_id, player_id, server_received_at DESC);

CREATE INDEX IF NOT EXISTS idx_runs_receipt
  ON runs (server_received_at DESC);

CREATE INDEX IF NOT EXISTS idx_runs_leaderboard_order
  ON runs (game_id, ruleset_version, score DESC, server_received_at ASC)
  WHERE verification_status = 'accepted';

CREATE INDEX IF NOT EXISTS idx_run_sessions_player_issued
  ON run_sessions (game_id, player_id, issued_at DESC);

CREATE INDEX IF NOT EXISTS idx_run_sessions_expiry
  ON run_sessions (status, expires_at);

CREATE INDEX IF NOT EXISTS idx_mobile_access_tokens_expiry
  ON mobile_access_tokens (expires_at, revoked_at);

CREATE INDEX IF NOT EXISTS idx_mobile_access_tokens_subject
  ON mobile_access_tokens (game_id, player_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_runs_session
  ON runs (run_session_id);

CREATE TABLE IF NOT EXISTS push_installations (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  provider TEXT NOT NULL CHECK (provider IN ('apns', 'fcm')),
  provider_environment TEXT NOT NULL DEFAULT 'production' CHECK (provider_environment IN ('sandbox', 'production')),
  token_ciphertext TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  notifications_enabled INTEGER NOT NULL DEFAULT 0 CHECK (notifications_enabled IN (0, 1)),
  rank_updates_enabled INTEGER NOT NULL DEFAULT 0 CHECK (rank_updates_enabled IN (0, 1)),
  admin_messages_enabled INTEGER NOT NULL DEFAULT 0 CHECK (admin_messages_enabled IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  invalidated_at INTEGER,
  UNIQUE (game_id, installation_id),
  UNIQUE (game_id, provider, token_hash),
  FOREIGN KEY (game_id, player_id) REFERENCES game_players(game_id, player_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_push_installations_player
  ON push_installations (game_id, player_id, invalidated_at, notifications_enabled);

CREATE TABLE IF NOT EXISTS notification_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  ruleset_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'reconciled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  processed_at INTEGER,
  UNIQUE (game_id, run_id),
  FOREIGN KEY (game_id, run_id) REFERENCES runs(game_id, run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS leaderboard_positions (
  game_id TEXT NOT NULL,
  ruleset_version TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('today', 'this_week', 'all_time')),
  period_start INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  rank INTEGER NOT NULL CHECK (rank >= 1),
  score INTEGER NOT NULL CHECK (score >= 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (game_id, ruleset_version, period, period_start, player_id),
  FOREIGN KEY (game_id, player_id) REFERENCES game_players(game_id, player_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_leaderboard_positions_lookup
  ON leaderboard_positions (game_id, ruleset_version, period, period_start, rank);

CREATE TABLE IF NOT EXISTS notification_campaigns (
  campaign_id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data_json)),
  audience TEXT NOT NULL CHECK (audience IN ('all_opted_in', 'player_ids')),
  created_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'completed', 'failed')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER,
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  delivery_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('rank_lost', 'admin_message')),
  campaign_id TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  sent_at INTEGER,
  FOREIGN KEY (installation_id) REFERENCES push_installations(id) ON DELETE CASCADE,
  FOREIGN KEY (game_id, player_id) REFERENCES game_players(game_id, player_id) ON DELETE CASCADE,
  FOREIGN KEY (campaign_id) REFERENCES notification_campaigns(campaign_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notification_events_pending
  ON notification_events (status, created_at);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_pending
  ON notification_deliveries (status, available_at, created_at);

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
