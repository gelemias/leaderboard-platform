INSERT OR IGNORE INTO games (id, slug, name, status) VALUES
  ('game-cloud-hopper', 'cloud-hopper', 'Cloud Hopper', 'active');

INSERT OR IGNORE INTO rulesets (id, game_id, version, eligible_for_leaderboard, validator_key) VALUES
  ('ruleset-cloud-hopper-1', 'game-cloud-hopper', 'cloud-hopper-1', 1, 'cloud-hopper-reference');

INSERT OR IGNORE INTO games (id, slug, name, status) VALUES
  ('game-jumpy-chewie', 'jumpy-chewie', 'Jumpy Chewie', 'active');

INSERT OR IGNORE INTO rulesets (id, game_id, version, eligible_for_leaderboard, validator_key) VALUES
  ('ruleset-jumpy-chewie-2', 'game-jumpy-chewie', 'jumpy-chewie-2', 1, 'jumpy-chewie-2'),
  ('ruleset-jumpy-chewie-3', 'game-jumpy-chewie', 'jumpy-chewie-3', 1, 'jumpy-chewie-3');
