-- Merge the Jumpy Chewie 2 history into Jumpy Chewie 3 while retaining the
-- version-2 ruleset row for its separate deprecation and grace-period flow.
UPDATE run_sessions
SET ruleset_version = 'jumpy-chewie-3'
WHERE game_id = 'game-jumpy-chewie'
	AND ruleset_version = 'jumpy-chewie-2';

UPDATE runs
SET ruleset_version = 'jumpy-chewie-3'
WHERE game_id = 'game-jumpy-chewie'
	AND ruleset_version = 'jumpy-chewie-2';

UPDATE notification_events
SET ruleset_version = 'jumpy-chewie-3'
WHERE game_id = 'game-jumpy-chewie'
	AND ruleset_version = 'jumpy-chewie-2';

-- Rank snapshots are derived state. Rebuild the active snapshots from the
-- merged run history so the next accepted run compares against the combined
-- v3 leaderboard and does not emit migration-induced rank-loss notifications.
DELETE FROM leaderboard_positions
WHERE game_id = 'game-jumpy-chewie'
	AND ruleset_version IN ('jumpy-chewie-2', 'jumpy-chewie-3');

WITH player_runs AS (
	SELECT player_id, score, server_received_at, run_id,
		ROW_NUMBER() OVER (
			PARTITION BY player_id
			ORDER BY score DESC, server_received_at ASC, run_id ASC
		) AS player_best
	FROM runs
	WHERE game_id = 'game-jumpy-chewie'
		AND ruleset_version = 'jumpy-chewie-3'
		AND verification_status = 'accepted'
), ranked_players AS (
	SELECT player_id, score,
		ROW_NUMBER() OVER (
			ORDER BY score DESC, server_received_at ASC, player_id ASC
		) AS rank
	FROM player_runs
	WHERE player_best = 1
)
INSERT INTO leaderboard_positions (
	game_id, ruleset_version, period, period_start, player_id, rank, score, updated_at
)
SELECT
	'game-jumpy-chewie', 'jumpy-chewie-3', 'all_time', 0,
	player_id, rank, score, unixepoch()
FROM ranked_players;

WITH period_bounds AS (
	SELECT unixepoch('now', 'start of day') AS period_start
), player_runs AS (
	SELECT r.player_id, r.score, r.server_received_at, r.run_id,
		ROW_NUMBER() OVER (
			PARTITION BY r.player_id
			ORDER BY r.score DESC, r.server_received_at ASC, r.run_id ASC
		) AS player_best
	FROM runs r, period_bounds p
	WHERE r.game_id = 'game-jumpy-chewie'
		AND r.ruleset_version = 'jumpy-chewie-3'
		AND r.verification_status = 'accepted'
		AND r.server_received_at >= p.period_start
), ranked_players AS (
	SELECT player_id, score,
		ROW_NUMBER() OVER (
			ORDER BY score DESC, server_received_at ASC, player_id ASC
		) AS rank
	FROM player_runs
	WHERE player_best = 1
)
INSERT INTO leaderboard_positions (
	game_id, ruleset_version, period, period_start, player_id, rank, score, updated_at
)
SELECT
	'game-jumpy-chewie', 'jumpy-chewie-3', 'today', p.period_start,
	r.player_id, r.rank, r.score, unixepoch()
FROM ranked_players r, period_bounds p;

WITH period_bounds AS (
	SELECT unixepoch(
		'now',
		'start of day',
		'-' || ((CAST(strftime('%w', 'now') AS INTEGER) + 6) % 7) || ' days'
	) AS period_start
), player_runs AS (
	SELECT r.player_id, r.score, r.server_received_at, r.run_id,
		ROW_NUMBER() OVER (
			PARTITION BY r.player_id
			ORDER BY r.score DESC, r.server_received_at ASC, r.run_id ASC
		) AS player_best
	FROM runs r, period_bounds p
	WHERE r.game_id = 'game-jumpy-chewie'
		AND r.ruleset_version = 'jumpy-chewie-3'
		AND r.verification_status = 'accepted'
		AND r.server_received_at >= p.period_start
), ranked_players AS (
	SELECT player_id, score,
		ROW_NUMBER() OVER (
			ORDER BY score DESC, server_received_at ASC, player_id ASC
		) AS rank
	FROM player_runs
	WHERE player_best = 1
)
INSERT INTO leaderboard_positions (
	game_id, ruleset_version, period, period_start, player_id, rank, score, updated_at
)
SELECT
	'game-jumpy-chewie', 'jumpy-chewie-3', 'this_week', p.period_start,
	r.player_id, r.rank, r.score, unixepoch()
FROM ranked_players r, period_bounds p;
