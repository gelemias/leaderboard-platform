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
