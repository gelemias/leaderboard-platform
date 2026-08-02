import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { consumeRateLimit, listRequiredTables, seedDevelopmentGame } from "../src/db";
import {
	PendingReplayValidator,
	replayStatsMatch,
	type ReplayStats,
} from "../src/domain/replay-validator";
import { replayValidatorRegistry } from "../src/domain/replay-registry";

const now = () => Math.floor(Date.now() / 1000);

const apiUrl = (path: string) => `https://example.com${path}`;

async function postJson(path: string, body: unknown) {
	return SELF.fetch(apiUrl(path), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function issueRunSession(playerId: string, gameBuildVersion = "test") {
	const response = await postJson("/v1/games/api-game/run-sessions", {
		player_id: playerId,
		ruleset_version: "api-v1",
		game_build_version: gameBuildVersion,
	});
	expect(response.status).toBe(201);
	return (await response.json()) as {
		run_id: string;
		session_token: string;
		run_seed: number;
		nonce: string;
	};
}

function validApiRun(
	session: { run_id: string; session_token: string; session_nonce: string; run_seed: number },
	playerId: string,
	score: number,
	name: string,
) {
	return {
		run_id: session.run_id,
		player_id: playerId,
		name,
		ruleset_version: "api-v1",
		score,
		jumps: score,
		near_misses: 0,
		highest_combo: 1,
		run_seed: session.run_seed,
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
		session_token: session.session_token,
		session_nonce: session.nonce,
		input_trace: [{ type: "swipe", t_ms: 100, direction: "right" }],
	};
}

function statsForRun(run: ReturnType<typeof validApiRun>): ReplayStats {
	return {
		score: run.score,
		jumps: run.jumps,
		near_misses: run.near_misses,
		highest_combo: run.highest_combo,
		power_up_types_collected: run.power_up_types_collected,
		power_up_collection_counts: run.power_up_collection_counts,
		power_up_activation_counts: run.power_up_activation_counts,
		shield_breaks: run.shield_breaks,
		double_gum_boosted_jumps: run.double_gum_boosted_jumps,
		jump_score_points: run.jump_score_points,
		double_gum_bonus_points: run.double_gum_bonus_points,
		golden_treat_bonus_points: run.golden_treat_bonus_points,
	};
}

async function insertRun(
	runId: string,
	gameId: string,
	playerId: string,
	rulesetVersion: string,
	score = 10,
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
			score,
			score,
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
			"request_limits",
			"rulesets",
			"run_sessions",
			"runs",
		]);
	});

	it("enforces and resets a persistent request window", async () => {
		const serverNow = 1_800_000_000;
		const first = await consumeRateLimit(env.DB, "test", "window-subject", 2, 60, serverNow);
		const second = await consumeRateLimit(env.DB, "test", "window-subject", 2, 60, serverNow + 1);
		const third = await consumeRateLimit(env.DB, "test", "window-subject", 2, 60, serverNow + 2);
		const nextWindow = await consumeRateLimit(env.DB, "test", "window-subject", 2, 60, serverNow + 60);

		expect(first).toMatchObject({ allowed: true, count: 1 });
		expect(second).toMatchObject({ allowed: true, count: 2 });
		expect(third).toMatchObject({ allowed: false, count: 3 });
		expect(nextWindow).toMatchObject({ allowed: true, count: 1 });
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

	it("issues a hashed, expiring run session", async () => {
		await postJson("/v1/games/api-game/players", {
			player_id: "api-player-session",
			display_name: "Session Player",
		});

		const session = await issueRunSession("api-player-session");
		expect(session.run_id).toMatch(/^[0-9a-f-]{36}$/);
		expect(session.session_token).toHaveLength(43);
		expect(session.nonce).toMatch(/^[0-9a-f-]{36}$/);

		const stored = await env.DB
			.prepare("SELECT run_id, token_hash, status FROM run_sessions WHERE run_id = ?")
			.bind(session.run_id)
			.first<{ run_id: string; token_hash: string; status: string }>();
		expect(stored).toMatchObject({ run_id: session.run_id, status: "issued" });
		expect(stored?.token_hash).not.toBe(session.session_token);
	});

	it("keeps unimplemented replay verification pending by default", async () => {
		const result = await new PendingReplayValidator().validate({
			run: {} as never,
			inputTrace: [],
			runSeed: 42,
			rulesetVersion: "api-v1",
			gameBuildVersion: "test",
		});
		expect(result).toEqual({ status: "pending", reason: "SIMULATOR_NOT_REGISTERED" });
	});

	it("requires the simulator result to match every submitted statistic", () => {
		const stats: ReplayStats = {
			score: 12,
			jumps: 5,
			near_misses: 2,
			highest_combo: 3,
			power_up_types_collected: ["double_gum"],
			power_up_collection_counts: { double_gum: 1 },
			power_up_activation_counts: { double_gum: 1 },
			shield_breaks: 0,
			double_gum_boosted_jumps: 5,
			jump_score_points: 7,
			double_gum_bonus_points: 5,
			golden_treat_bonus_points: 0,
		};
		expect(replayStatsMatch(stats, { ...stats, power_up_collection_counts: { double_gum: 2 } })).toBe(false);
		expect(replayStatsMatch(stats, { ...stats, power_up_collection_counts: { double_gum: 1 } })).toBe(true);
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

	it("updates a player name and rejects a name already used in the game", async () => {
		await postJson("/v1/games/api-game/players", {
			player_id: "api-player-rename",
			display_name: "Old Player",
		});
		await postJson("/v1/games/api-game/players", {
			player_id: "api-player-rename-other",
			display_name: "Taken Player",
		});

		const renamed = await SELF.fetch(apiUrl("/v1/games/api-game/players/api-player-rename"), {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ display_name: "New Player" }),
		});
		expect(renamed.status).toBe(200);
		expect(await renamed.json()).toEqual({
			ok: true,
			player_id: "api-player-rename",
			name: "New Player",
		});

		const conflict = await SELF.fetch(apiUrl("/v1/games/api-game/players/api-player-rename"), {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ display_name: "Taken Player" }),
		});
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toMatchObject({ ok: false, error: { code: "PLAYER_NAME_CONFLICT" } });
	});

	it("accepts a valid run idempotently and rejects a changed duplicate", async () => {
		await postJson("/v1/games/api-game/players", {
			player_id: "api-player-runs",
			display_name: "Run Player",
		});
		const session = await issueRunSession("api-player-runs");
		const body = validApiRun(session, "api-player-runs", 10, "Run Player");

		const first = await postJson("/v1/games/api-game/runs", body);
		expect(first.status).toBe(201);
		expect(await first.json()).toMatchObject({
			ok: true,
			duplicate: false,
			run_id: body.run_id,
			verification_status: "pending",
			verification_code: "REPLAY_VALIDATION_PENDING",
		});

		const duplicate = await postJson("/v1/games/api-game/runs", body);
		expect(duplicate.status).toBe(200);
		expect(await duplicate.json()).toMatchObject({ ok: true, duplicate: true, run_id: body.run_id });

		const changed = { ...body, score: 11, jumps: 11, jump_score_points: 11 };
		const conflict = await postJson("/v1/games/api-game/runs", changed);
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toMatchObject({ ok: false, error: { code: "RUN_ID_CONFLICT" } });

		const tutorial = await postJson("/v1/games/api-game/runs", {
			...validApiRun(await issueRunSession("api-player-runs"), "api-player-runs", 10, "Run Player"),
			run_mode: "tutorial",
		});
		expect(tutorial.status).toBe(422);

		const board = await SELF.fetch(
			apiUrl("/v1/games/api-game/leaderboards/all_time?ruleset_version=api-v1&player_id=api-player-runs"),
		);
		expect(board.status).toBe(200);
		expect((await board.json()).entries).toEqual([]);
	});

	it("binds evidence to its session and rejects malformed replay traces", async () => {
		await postJson("/v1/games/api-game/players", {
			player_id: "api-player-evidence",
			display_name: "Evidence Player",
		});
		const session = await issueRunSession("api-player-evidence");
		const invalidTrace = {
			...validApiRun(session, "api-player-evidence", 10, "Evidence Player"),
			input_trace: [
				{ type: "swipe", t_ms: 200, direction: "right" },
				{ type: "swipe", t_ms: 100, direction: "left" },
			],
		};
		const invalidResponse = await postJson("/v1/games/api-game/runs", invalidTrace);
		expect(invalidResponse.status).toBe(422);
		expect(await invalidResponse.json()).toMatchObject({ ok: false, error: { code: "INVALID_RUN" } });

		const otherSession = await issueRunSession("api-player-evidence");
		const mismatch = await postJson("/v1/games/api-game/runs", {
			...validApiRun(session, "api-player-evidence", 10, "Evidence Player"),
			run_id: otherSession.run_id,
		});
		expect(mismatch.status).toBe(409);
		expect(await mismatch.json()).toMatchObject({ ok: false, error: { code: "RUN_SESSION_MISMATCH" } });
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

		for (const [runId, playerId, score] of [
			["api-run-a-low", "api-player-a", 20, "Player A"],
			["api-run-a-best", "api-player-a", 30, "Player A"],
			["api-run-b", "api-player-b", 15, "Player B"],
		] as const) {
			await insertRun(runId, "game-api", playerId, "api-v1", score);
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

	it("promotes only an exact result from a registered simulator", async () => {
		await postJson("/v1/games/api-game/players", {
			player_id: "api-player-verified",
			display_name: "Verified Player",
		});
		const firstSession = await issueRunSession("api-player-verified");
		const firstRun = validApiRun(firstSession, "api-player-verified", 10, "Verified Player");
		const authoritativeStats = statsForRun(firstRun);

		replayValidatorRegistry.register("game-api", "api-v1", "test", {
			validate: async () => ({
				status: "accepted",
				reason: "AUTHORITATIVE_REPLAY_MATCH",
				stats: authoritativeStats,
			}),
		});

		try {
			const accepted = await postJson("/v1/games/api-game/runs", firstRun);
			expect(accepted.status).toBe(201);
			expect(await accepted.json()).toMatchObject({
				verification_status: "accepted",
				verification_code: "REPLAY_VALIDATED",
			});

			const secondSession = await issueRunSession("api-player-verified");
			const mismatchedRun = validApiRun(secondSession, "api-player-verified", 11, "Verified Player");
			const rejected = await postJson("/v1/games/api-game/runs", mismatchedRun);
			expect(rejected.status).toBe(201);
			expect(await rejected.json()).toMatchObject({
				verification_status: "rejected",
				verification_code: "REPLAY_VALIDATION_REJECTED",
			});

			const board = await SELF.fetch(
				apiUrl("/v1/games/api-game/leaderboards/all_time?ruleset_version=api-v1&player_id=api-player-verified"),
			);
			expect((await board.json()).entries.map((entry: { score: number }) => entry.score)).toEqual([10]);
		} finally {
			replayValidatorRegistry.remove("game-api", "api-v1", "test");
		}
	});
});
