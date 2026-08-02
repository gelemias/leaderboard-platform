ALTER TABLE rulesets ADD COLUMN validator_key TEXT NOT NULL DEFAULT 'generic';
ALTER TABLE runs ADD COLUMN game_stats TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(game_stats));

CREATE INDEX IF NOT EXISTS idx_rulesets_validator
  ON rulesets (game_id, validator_key, version);
