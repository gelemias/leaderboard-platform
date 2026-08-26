import type {
	GamePlayerRow,
	GameRow,
	MobileAccessTokenRow,
	RulesetRow,
	RunRow,
	RunSessionRow,
} from "./types";

const REQUIRED_TABLES = [
	"games",
	"rulesets",
	"players",
	"game_players",
	"runs",
	"run_sessions",
	"mobile_access_tokens",
	"push_installations",
	"notification_events",
	"leaderboard_positions",
	"notification_campaigns",
	"notification_deliveries",
	"request_limits",
] as const;

export type DatabaseHealth = {
	available: boolean;
	message?: string;
};

export async function checkDatabase(db: D1Database): Promise<DatabaseHealth> {
	try {
		const result = await db.prepare("SELECT 1 AS ok").first<{ ok: number }>();
		return result?.ok === 1
			? { available: true }
			: { available: false, message: "D1 returned an unexpected result" };
	} catch {
		return { available: false, message: "D1 is unavailable" };
	}
}

export async function getGameBySlug(db: D1Database, slug: string): Promise<GameRow | null> {
	return db
		.prepare("SELECT id, slug, name, status FROM games WHERE slug = ? LIMIT 1")
		.bind(slug)
		.first<GameRow>();
}

export async function getRuleset(
	db: D1Database,
	gameId: string,
	version: string,
): Promise<RulesetRow | null> {
	return db
		.prepare(
			"SELECT id, game_id, version, eligible_for_leaderboard, validator_key FROM rulesets WHERE game_id = ? AND version = ? LIMIT 1",
		)
		.bind(gameId, version)
		.first<RulesetRow>();
}

export async function getGamePlayer(
	db: D1Database,
	gameId: string,
	playerId: string,
): Promise<GamePlayerRow | null> {
	return db
		.prepare(
			"SELECT game_id, player_id, display_name FROM game_players WHERE game_id = ? AND player_id = ? LIMIT 1",
		)
		.bind(gameId, playerId)
		.first<GamePlayerRow>();
}

export async function getRunById(db: D1Database, runId: string): Promise<RunRow | null> {
	return db
		.prepare(
			`SELECT run_id, game_id, player_id, ruleset_version, score, jumps, near_misses,
				highest_combo, run_seed, run_duration, game_build_version, run_mode,
				client_completed_at, server_received_at, verification_status,
				power_up_types_collected, power_up_collection_counts,
				power_up_activation_counts, shield_breaks, double_gum_boosted_jumps,
				jump_score_points, double_gum_bonus_points, golden_treat_bonus_points,
				run_session_id, input_trace, game_stats
			 FROM runs WHERE run_id = ? LIMIT 1`,
		)
		.bind(runId)
		.first<RunRow>();
}

export async function getPendingRuns(db: D1Database, limit: number): Promise<RunRow[]> {
	return (
		await db
			.prepare(
				`SELECT run_id, game_id, player_id, ruleset_version, score, jumps, near_misses,
					highest_combo, run_seed, run_duration, game_build_version, run_mode,
					client_completed_at, server_received_at, verification_status,
					power_up_types_collected, power_up_collection_counts,
					power_up_activation_counts, shield_breaks, double_gum_boosted_jumps,
					jump_score_points, double_gum_bonus_points, golden_treat_bonus_points,
					run_session_id, input_trace, game_stats
				 FROM runs
				 WHERE verification_status = 'pending'
				 ORDER BY server_received_at ASC, run_id ASC
				 LIMIT ?`,
			)
			.bind(limit)
			.all<RunRow>()
	).results;
}

export async function getRunSessionByTokenHash(
	db: D1Database,
	tokenHash: string,
): Promise<RunSessionRow | null> {
	return db
		.prepare(
			`SELECT run_id, game_id, player_id, ruleset_version, game_build_version,
				run_seed, token_hash, nonce, issued_at, expires_at, consumed_at, status
			 FROM run_sessions WHERE token_hash = ? LIMIT 1`,
		)
		.bind(tokenHash)
		.first<RunSessionRow>();
}

export async function getMobileAccessTokenByHash(
	db: D1Database,
	tokenHash: string,
): Promise<MobileAccessTokenRow | null> {
	return db
		.prepare(
			`SELECT token_id, game_id, player_id, token_hash, issued_at, expires_at, revoked_at
			 FROM mobile_access_tokens WHERE token_hash = ? LIMIT 1`,
		)
		.bind(tokenHash)
		.first<MobileAccessTokenRow>();
}

export type RateLimitResult = {
	allowed: boolean;
	count: number;
	limit: number;
	resetAt: number;
};

export async function consumeRateLimit(
	db: D1Database,
	scope: string,
	subject: string,
	limit: number,
	windowSeconds: number,
	serverNow = Math.floor(Date.now() / 1000),
): Promise<RateLimitResult> {
	const windowStartedAt = serverNow - (serverNow % windowSeconds);
	const resetAt = windowStartedAt + windowSeconds;
	const session = db.withSession("first-primary");

	await session
		.prepare(
			`INSERT INTO request_limits (scope, subject, window_started_at, request_count)
			 VALUES (?, ?, ?, 1)
			 ON CONFLICT (scope, subject) DO UPDATE SET
				window_started_at = CASE
					WHEN request_limits.window_started_at = excluded.window_started_at
					THEN request_limits.window_started_at ELSE excluded.window_started_at END,
				request_count = CASE
					WHEN request_limits.window_started_at = excluded.window_started_at
					THEN request_limits.request_count + 1 ELSE 1 END`,
		)
		.bind(scope, subject, windowStartedAt)
		.run();

	const row = await session
		.prepare("SELECT request_count FROM request_limits WHERE scope = ? AND subject = ? LIMIT 1")
		.bind(scope, subject)
		.first<{ request_count: number }>();
	const count = row?.request_count ?? 0;

	return { allowed: count <= limit, count, limit, resetAt };
}

export async function listRequiredTables(db: D1Database): Promise<string[]> {
	const placeholders = REQUIRED_TABLES.map(() => "?").join(", ");
	const result = await db
		.prepare(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders}) ORDER BY name`,
		)
		.bind(...REQUIRED_TABLES)
		.all<{ name: string }>();

	return result.results.map((row) => row.name);
}

export async function seedDevelopmentGame(db: D1Database): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	await db.batch([
		db
			.prepare(
				"INSERT OR IGNORE INTO games (id, slug, name, status, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.bind("game-cloud-hopper", "cloud-hopper", "Cloud Hopper", "active", now),
		db
			.prepare(
				"INSERT OR IGNORE INTO rulesets (id, game_id, version, eligible_for_leaderboard, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.bind("ruleset-cloud-hopper-1", "game-cloud-hopper", "cloud-hopper-1", 1, now),
		db
			.prepare("UPDATE rulesets SET validator_key = ? WHERE game_id = ? AND version = ?")
			.bind("cloud-hopper-reference", "game-cloud-hopper", "cloud-hopper-1"),
		db
			.prepare(
				"INSERT OR IGNORE INTO games (id, slug, name, status, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.bind("game-jumpy-chewie", "jumpy-chewie", "Jumpy Chewie", "active", now),
		db
			.prepare(
				"INSERT OR IGNORE INTO rulesets (id, game_id, version, eligible_for_leaderboard, created_at, validator_key) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.bind(
				"ruleset-jumpy-chewie-2",
				"game-jumpy-chewie",
				"jumpy-chewie-2",
				1,
				now,
				"jumpy-chewie-2",
			),
		db
			.prepare(
				"INSERT OR IGNORE INTO rulesets (id, game_id, version, eligible_for_leaderboard, created_at, validator_key) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.bind(
				"ruleset-jumpy-chewie-3",
				"game-jumpy-chewie",
				"jumpy-chewie-3",
				1,
				now,
				"jumpy-chewie-3",
			),
	]);
}
