import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { listRequiredTables, seedDevelopmentGame } from "../src/db";

const now = () => Math.floor(Date.now() / 1000);

async function insertRun(
	runId: string,
	gameId: string,
	playerId: string,
	rulesetVersion: string,
) {
	return env.DB
		.prepare(
			`INSERT INTO runs (
				run_id, game_id, player_id, ruleset_version, score, jumps, near_misses,
				highest_combo, run_seed, run_duration, game_build_version, run_mode,
				client_completed_at, server_received_at, verification_status
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			runId,
			gameId,
			playerId,
			rulesetVersion,
			10,
			10,
			0,
			1,
			42,
			20,
			"test",
			"normal",
			now(),
			now(),
			"accepted",
		)
		.run();
}

beforeAll(async () => {
	await seedDevelopmentGame(env.DB);
	await env.DB.batch([
		env.DB.prepare("INSERT OR IGNORE INTO players (id) VALUES (?)").bind("seed-player"),
		env.DB
			.prepare(
				"INSERT OR IGNORE INTO game_players (game_id, player_id, display_name) VALUES (?, ?, ?)",
			)
			.bind("game-cloud-hopper", "seed-player", "Seed Player"),
	]);
});

describe("leaderboard platform foundation", () => {
	it("reports worker and D1 health", async () => {
		const response = await SELF.fetch("https://example.com/health");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			service: "leaderboard-platform",
			database: { available: true },
		});
	});

	it("initializes the required database tables", async () => {
		expect(await listRequiredTables(env.DB)).toEqual([
			"game_players",
			"games",
			"players",
			"rulesets",
			"runs",
		]);
	});

	it("contains the development game and ruleset seed", async () => {
		const game = await env.DB
			.prepare("SELECT id, slug, name, status FROM games WHERE slug = ?")
			.bind("cloud-hopper")
			.first();
		const ruleset = await env.DB
			.prepare("SELECT game_id, version, eligible_for_leaderboard FROM rulesets WHERE game_id = ?")
			.bind("game-cloud-hopper")
			.first();

		expect(game).toEqual({
			id: "game-cloud-hopper",
			slug: "cloud-hopper",
			name: "Cloud Hopper",
			status: "active",
		});
		expect(ruleset).toMatchObject({
			game_id: "game-cloud-hopper",
			version: "cloud-hopper-1",
			eligible_for_leaderboard: 1,
		});
	});

	it("rejects a duplicate run ID", async () => {
		await insertRun("duplicate-run", "game-cloud-hopper", "seed-player", "cloud-hopper-1");

		await expect(
			insertRun("duplicate-run", "game-cloud-hopper", "seed-player", "cloud-hopper-1"),
		).rejects.toThrow();
	});

	it("keeps runs isolated by game and ruleset", async () => {
		await env.DB.batch([
			env.DB.prepare("INSERT OR IGNORE INTO games (id, slug, name) VALUES (?, ?, ?)").bind(
				"game-a",
				"game-a",
				"Game A",
			),
			env.DB.prepare("INSERT OR IGNORE INTO games (id, slug, name) VALUES (?, ?, ?)").bind(
				"game-b",
				"game-b",
				"Game B",
			),
			env.DB.prepare("INSERT OR IGNORE INTO rulesets (id, game_id, version) VALUES (?, ?, ?)").bind(
				"ruleset-a",
				"game-a",
				"game-a-v1",
			),
			env.DB.prepare("INSERT OR IGNORE INTO rulesets (id, game_id, version) VALUES (?, ?, ?)").bind(
				"ruleset-b",
				"game-b",
				"game-b-v1",
			),
			env.DB.prepare("INSERT OR IGNORE INTO game_players (game_id, player_id, display_name) VALUES (?, ?, ?)").bind(
				"game-a",
				"seed-player",
				"Seed Player A",
			),
			env.DB.prepare("INSERT OR IGNORE INTO game_players (game_id, player_id, display_name) VALUES (?, ?, ?)").bind(
				"game-b",
				"seed-player",
				"Seed Player B",
			),
		]);

		await insertRun("run-a", "game-a", "seed-player", "game-a-v1");
		await insertRun("run-b", "game-b", "seed-player", "game-b-v1");

		const counts = await env.DB
			.prepare(
				"SELECT game_id, ruleset_version, COUNT(*) AS count FROM runs WHERE run_id IN (?, ?) GROUP BY game_id, ruleset_version ORDER BY game_id",
			)
			.bind("run-a", "run-b")
			.all();
		expect(counts.results).toEqual([
			{ game_id: "game-a", ruleset_version: "game-a-v1", count: 1 },
			{ game_id: "game-b", ruleset_version: "game-b-v1", count: 1 },
		]);

		await expect(insertRun("wrong-ruleset", "game-a", "seed-player", "game-b-v1")).rejects.toThrow();
	});
});
