import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { listRequiredTables, seedDevelopmentGame } from "../src/db";

const now = () => Math.floor(Date.now() / 1000);

const apiUrl = (path: string) => `https://example.com${path}`;

async function postJson(path: string, body: unknown) {
	return SELF.fetch(apiUrl(path), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function validApiRun(runId: string, playerId: string, score: number, name: string) {
	return {
		run_id: runId,
		player_id: playerId,
		name,
		ruleset_version: "api-v1",
		score,
		jumps: score,
		near_misses: 0,
		highest_combo: 1,
		run_seed: 42,
		run_duration: 20,
		game_build_version: "test",
		run_mode: "normal",
		client_completed_at: now(),
		power_up_types_collected: [],
		power_up_collection_counts: { shield: 0, double_gum: 0, golden_treat: 0 },
		power_up_activation_counts: { shield: 0, double_gum: 0, golden_treat: 0 },
		shield_breaks: 0,
		double_gum_boosted_jumps: 0,
		jump_score_points: score,
		double_gum_bonus_points: 0,
		golden_treat_bonus_points: 0,
	};
}

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
		env.DB.prepare("INSERT OR IGNORE INTO games (id, slug, name) VALUES (?, ?, ?)").bind(
			"game-api",
			"api-game",
			"API Game",
		),
		env.DB.prepare("INSERT OR IGNORE INTO rulesets (id, game_id, version) VALUES (?, ?, ?)").bind(
			"ruleset-api-v1",
			"game-api",
			"api-v1",
		),
		env.DB.prepare("INSERT OR IGNORE INTO rulesets (id, game_id, version) VALUES (?, ?, ?)").bind(
			"ruleset-api-v2",
			"game-api",
			"api-v2",
		),
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

	it("registers and restores a player without silently changing their name", async () => {
		const created = await postJson("/v1/games/api-game/players", {
			player_id: "api-player-restore",
			display_name: "  Route   Player ",
		});
		expect(created.status).toBe(201);
		expect(await created.json()).toEqual({
			ok: true,
			player_id: "api-player-restore",
			name: "Route Player",
			created: true,
		});

		const restored = await postJson("/v1/games/api-game/players", {
			player_id: "api-player-restore",
			display_name: "Changed Name",
		});
		expect(restored.status).toBe(200);
		expect(await restored.json()).toEqual({
			ok: true,
			player_id: "api-player-restore",
			name: "Route Player",
			created: false,
		});
	});

	it("accepts a valid run idempotently and rejects a changed duplicate", async () => {
		await postJson("/v1/games/api-game/players", {
			player_id: "api-player-runs",
			display_name: "Run Player",
		});
		const body = validApiRun("api-run-1", "api-player-runs", 10, "Run Player");

		const first = await postJson("/v1/games/api-game/runs", body);
		expect(first.status).toBe(201);
		expect(await first.json()).toMatchObject({
			ok: true,
			duplicate: false,
			run_id: "api-run-1",
			verification_status: "accepted",
		});

		const duplicate = await postJson("/v1/games/api-game/runs", body);
		expect(duplicate.status).toBe(200);
		expect(await duplicate.json()).toMatchObject({ ok: true, duplicate: true, run_id: "api-run-1" });

		const changed = { ...body, score: 11, jumps: 11, jump_score_points: 11 };
		const conflict = await postJson("/v1/games/api-game/runs", changed);
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toMatchObject({ ok: false, error: { code: "RUN_ID_CONFLICT" } });

		const tutorial = await postJson("/v1/games/api-game/runs", {
			...validApiRun("api-run-tutorial", "api-player-runs", 10, "Run Player"),
			run_mode: "tutorial",
		});
		expect(tutorial.status).toBe(422);
	});

	it("ranks one best run per player and isolates rulesets", async () => {
		await postJson("/v1/games/api-game/players", {
			player_id: "api-player-a",
			display_name: "Player A",
		});
		await postJson("/v1/games/api-game/players", {
			player_id: "api-player-b",
			display_name: "Player B",
		});

		for (const [runId, playerId, score, name] of [
			["api-run-a-low", "api-player-a", 20, "Player A"],
			["api-run-a-best", "api-player-a", 30, "Player A"],
			["api-run-b", "api-player-b", 15, "Player B"],
		] as const) {
			const response = await postJson("/v1/games/api-game/runs", validApiRun(runId, playerId, score, name));
			expect(response.status).toBe(201);
		}

		const response = await SELF.fetch(
			apiUrl(
				"/v1/games/api-game/leaderboards/today?ruleset_version=api-v1&player_id=api-player-b&nearby_limit=1",
			),
		);
		expect(response.status).toBe(200);
		const board = (await response.json()) as {
			entries: Array<{ player_id: string; score: number; rank: number }>;
			nearby: Array<{ player_id: string }>;
			current_rank: number;
			total_players: number;
		};
		expect(board.entries.map((entry) => [entry.player_id, entry.score, entry.rank])).toEqual([
			["api-player-a", 30, 1],
			["api-player-b", 15, 2],
		]);
		expect(board.current_rank).toBe(2);
		expect(board.total_players).toBe(2);
		expect(board.nearby.map((entry) => entry.player_id)).toEqual(["api-player-a", "api-player-b"]);

		const isolated = await SELF.fetch(
			apiUrl("/v1/games/api-game/leaderboards/today?ruleset_version=api-v2"),
		);
		expect(isolated.status).toBe(200);
		expect((await isolated.json()).entries).toEqual([]);
	});
});
