const REQUIRED_TABLES = ["games", "rulesets", "players", "game_players", "runs"] as const;

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
	]);
}
