-- Names become competitive reservations only when a score is accepted. Older
-- provisioning rows can otherwise hide a name forever even though they never
-- appear on a leaderboard.
UPDATE game_players
SET display_name = 'Mobile ' || lower(hex(randomblob(4))),
    updated_at = unixepoch()
WHERE NOT EXISTS (
	SELECT 1
	FROM runs
	WHERE runs.game_id = game_players.game_id
		AND runs.player_id = game_players.player_id
		AND runs.verification_status = 'accepted'
)
	AND display_name NOT LIKE 'Mobile ________';
