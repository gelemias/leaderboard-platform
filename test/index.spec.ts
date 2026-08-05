import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { consumeRateLimit, listRequiredTables, seedDevelopmentGame } from "../src/db";
import {
	PendingReplayValidator,
	replayStatsMatch,
	type ReplayStats,
} from "../src/domain/replay-validator";
import { replayValidatorRegistry } from "../src/domain/replay-registry";
import {
	normalizeReplayInputTrace,
	translateJumpyReplayContract,
} from "../src/domain/simulators/jumpy-chewie-translation";
import { revalidatePendingRuns } from "../src/domain/revalidate-pending";
import {
	acceptedRunEventStatement,
	processNotificationEvents,
} from "../src/domain/notifications";
import { tokenMatches } from "../src/auth";
import { getRateLimits } from "../src/config";

const now = () => Math.floor(Date.now() / 1000);

const apiUrl = (path: string) => `https://example.com${path}`;

async function postJson(path: string, body: unknown) {
	return SELF.fetch(apiUrl(path), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function issueRunSessionFor(
	gameSlug: string,
	playerId: string,
	rulesetVersion: string,
	gameBuildVersion: string,
) {
	const response = await postJson(`/v1/games/${gameSlug}/run-sessions`, {
		player_id: playerId,
		ruleset_version: rulesetVersion,
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

async function issueMobileAccessToken(playerId?: string) {
	const response = await postJson(
		"/v1/mobile/games/api-game/access-tokens",
		playerId ? { player_id: playerId } : {},
	);
	expect(response.status).toBe(201);
	return (await response.json()) as {
		access_token: string;
		expires_at: number;
		expires_in: number;
		player_id: string;
		name: string;
	};
}

async function issueRunSession(playerId: string, gameBuildVersion = "test") {
	return issueRunSessionFor("api-game", playerId, "api-v1", gameBuildVersion);
}

function validApiRun(
	session: { run_id: string; session_token: string; nonce: string; run_seed: number },
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
		game_stats: { jumps: score, near_misses: 0, highest_combo: 1 },
		session_token: session.session_token,
		session_nonce: session.nonce,
		input_trace: [{ type: "swipe", t_ms: 100, direction: "right" }],
	};
}

function statsForRun(run: ReturnType<typeof validApiRun>): ReplayStats {
	return {
		score: run.score,
		game_stats: run.game_stats,
	};
}

async function insertRun(
	runId: string,
	gameId: string,
	playerId: string,
	rulesetVersion: string,
	score = 10,
	verificationStatus = "accepted",
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
			verificationStatus,
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
	it("registers, updates, and removes an opted-in push installation", async () => {
		const playerId = "push-installation-player";
		await postJson("/v1/games/api-game/players", { player_id: playerId, display_name: "Push Player" });
		const mobileToken = await issueMobileAccessToken(playerId);
		const path = "/v1/mobile/games/api-game/push-installations/test-installation";
		const registered = await SELF.fetch(apiUrl(path), {
			method: "PUT",
			headers: { Authorization: `Bearer ${mobileToken.access_token}`, "content-type": "application/json" },
			body: JSON.stringify({
				platform: "android",
				provider: "fcm",
				token: "fcm-token-for-push-installation",
				notifications_enabled: true,
				rank_updates_enabled: true,
				admin_messages_enabled: false,
			}),
		});
		expect(registered.status).toBe(200);
		const stored = await env.DB
			.prepare("SELECT player_id, provider, token_ciphertext, notifications_enabled, rank_updates_enabled FROM push_installations WHERE game_id = ? AND installation_id = ?")
			.bind("game-api", "test-installation")
			.first();
		expect(stored).toMatchObject({ player_id: playerId, provider: "fcm", notifications_enabled: 1, rank_updates_enabled: 1 });
		expect(stored?.token_ciphertext).not.toBe("fcm-token-for-push-installation");

		const preferences = await SELF.fetch(apiUrl(path), {
			method: "PATCH",
			headers: { Authorization: `Bearer ${mobileToken.access_token}`, "content-type": "application/json" },
			body: JSON.stringify({ rank_updates_enabled: false, admin_messages_enabled: true }),
		});
		expect(preferences.status).toBe(200);
		const removed = await SELF.fetch(apiUrl(path), {
			method: "DELETE",
			headers: { Authorization: `Bearer ${mobileToken.access_token}` },
		});
		expect(removed.status).toBe(200);
	});

	it("creates rank-loss deliveries for accepted runs, including the all-time board", async () => {
		const firstPlayer = "push-rank-first";
		const secondPlayer = "push-rank-second";
		await postJson("/v1/games/api-game/players", { player_id: firstPlayer, display_name: "Rank First" });
		await postJson("/v1/games/api-game/players", { player_id: secondPlayer, display_name: "Rank Second" });
		const firstToken = await issueMobileAccessToken(firstPlayer);
		await SELF.fetch(apiUrl("/v1/mobile/games/api-game/push-installations/rank-installation"), {
			method: "PUT",
			headers: { Authorization: `Bearer ${firstToken.access_token}`, "content-type": "application/json" },
			body: JSON.stringify({ platform: "android", provider: "fcm", token: "fcm-token-for-rank-installation", notifications_enabled: true, rank_updates_enabled: true }),
		});
		await insertRun("push-rank-first-run", "game-api", firstPlayer, "api-v1", 10);
		await env.DB.batch([
			acceptedRunEventStatement(env.DB, { run_id: "push-rank-first-run", game_id: "game-api", ruleset_version: "api-v1" }),
		]);
		await processNotificationEvents(env.DB);
		await insertRun("push-rank-second-run", "game-api", secondPlayer, "api-v1", 20);
		await env.DB.batch([
			acceptedRunEventStatement(env.DB, { run_id: "push-rank-second-run", game_id: "game-api", ruleset_version: "api-v1" }),
		]);
		await processNotificationEvents(env.DB);
		const deliveries = await env.DB
			.prepare("SELECT kind, body FROM notification_deliveries WHERE player_id = ? AND kind = 'rank_lost'")
			.bind(firstPlayer)
			.all<{ kind: string; body: string }>();
		expect(deliveries.results.length).toBeGreaterThanOrEqual(3);
		expect(deliveries.results.some((delivery) => delivery.body.includes("#1 to #2"))).toBe(true);
	});

	it("queues an admin campaign only for installations that opted into admin messages", async () => {
		const playerId = "push-admin-player";
		await postJson("/v1/games/api-game/players", { player_id: playerId, display_name: "Admin Push" });
		const mobileToken = await issueMobileAccessToken(playerId);
		await SELF.fetch(apiUrl("/v1/mobile/games/api-game/push-installations/admin-installation"), {
			method: "PUT",
			headers: { Authorization: `Bearer ${mobileToken.access_token}`, "content-type": "application/json" },
			body: JSON.stringify({ platform: "android", provider: "fcm", token: "fcm-token-for-admin-installation", notifications_enabled: true, admin_messages_enabled: true }),
		});
		const response = await postJson("/v1/admin/games/api-game/notifications/campaigns", {
			title: "Tournament",
			body: "The tournament starts now.",
			audience: "all_opted_in",
		});
		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({ ok: true, recipients: 1 });
	});

	it("lists searchable admin message targets with push eligibility", async () => {
		const eligiblePlayer = "push-directory-eligible";
		const unavailablePlayer = "push-directory-unavailable";
		await postJson("/v1/games/api-game/players", { player_id: eligiblePlayer, display_name: "Directory Target" });
		await postJson("/v1/games/api-game/players", { player_id: unavailablePlayer, display_name: "Target Offline" });
		const mobileToken = await issueMobileAccessToken(eligiblePlayer);
		await SELF.fetch(apiUrl("/v1/mobile/games/api-game/push-installations/directory-installation"), {
			method: "PUT",
			headers: { Authorization: `Bearer ${mobileToken.access_token}`, "content-type": "application/json" },
			body: JSON.stringify({
				platform: "android",
				provider: "fcm",
				token: "fcm-token-for-directory-installation",
				notifications_enabled: true,
				admin_messages_enabled: true,
			}),
		});

		const response = await SELF.fetch(apiUrl("/v1/admin/games/api-game/players?search=Target"));
		expect(response.status).toBe(200);
		const result = (await response.json()) as {
			players: Array<{ player_id: string; display_name: string; installation_count: number; eligible_installation_count: number }>;
		};
		expect(result.players).toEqual(expect.arrayContaining([
			expect.objectContaining({ player_id: eligiblePlayer, installation_count: 1, eligible_installation_count: 1 }),
			expect.objectContaining({ player_id: unavailablePlayer, installation_count: 0, eligible_installation_count: 0 }),
		]));
	});

	it("lists active games for the admin selector", async () => {
		const response = await SELF.fetch(apiUrl("/v1/admin/games"));
		expect(response.status).toBe(200);
		const result = (await response.json()) as { games: Array<{ slug: string; name: string }> };
		expect(result.games).toEqual(expect.arrayContaining([
			expect.objectContaining({ slug: "api-game", name: "API Game" }),
		]));
	});

	it("removes a player and their game-scoped data through the admin route", async () => {
		const playerId = "admin-removal-player";
		await postJson("/v1/games/api-game/players", { player_id: playerId, display_name: "Admin Remove" });
		const response = await SELF.fetch(apiUrl(`/v1/admin/games/api-game/players/${playerId}`), { method: "DELETE" });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true, player_id: playerId, removed: true });
		expect(await env.DB.prepare("SELECT 1 AS present FROM game_players WHERE game_id = ? AND player_id = ?").bind("game-api", playerId).first()).toBeNull();
		expect(await env.DB.prepare("SELECT 1 AS present FROM players WHERE id = ?").bind(playerId).first()).toMatchObject({ present: 1 });
	});

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
			"leaderboard_positions",
			"mobile_access_tokens",
			"notification_campaigns",
			"notification_deliveries",
			"notification_events",
			"players",
			"push_installations",
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

	it("exposes a generic public game catalog and leaderboard read API", async () => {
		const catalog = await SELF.fetch("https://example.com/v1/public/games");
		expect(catalog.status).toBe(200);
		expect(await catalog.json()).toMatchObject({
			ok: true,
			games: expect.arrayContaining([
				expect.objectContaining({
					slug: "jumpy-chewie",
					name: "Jumpy Chewie",
					rulesets: [{ version: "jumpy-chewie-2" }],
				}),
			]),
		});

		const leaderboard = await SELF.fetch(
			"https://example.com/v1/public/games/jumpy-chewie/leaderboards/all_time?ruleset_version=jumpy-chewie-2",
		);
		expect(leaderboard.status).toBe(200);
		expect(await leaderboard.json()).toMatchObject({
			ok: true,
			ruleset: "jumpy-chewie-2",
			entries: expect.any(Array),
		});
	});

	it("seeds Jumpy metadata with trusted mode enabled by default", async () => {
		const ruleset = await env.DB
			.prepare("SELECT game_id, version, validator_key FROM rulesets WHERE game_id = ? AND version = ?")
			.bind("game-jumpy-chewie", "jumpy-chewie-2")
			.first();

		expect(ruleset).toEqual({
			game_id: "game-jumpy-chewie",
			version: "jumpy-chewie-2",
			validator_key: "jumpy-chewie-2",
		});
		expect(
			await replayValidatorRegistry
				.get("game-jumpy-chewie", "jumpy-chewie-2", "0.1.0")
				.validate({
					run: {} as never,
					inputTrace: [],
					runSeed: 1,
					rulesetVersion: "jumpy-chewie-2",
					gameBuildVersion: "0.1.0",
				}),
		).toMatchObject({ status: "accepted", reason: "TRUSTED_SUBMISSION" });
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

	it("keeps explicit fail-closed replay verification pending", async () => {
		const result = await new PendingReplayValidator().validate({
			run: {} as never,
			inputTrace: [],
			runSeed: 42,
			rulesetVersion: "api-v1",
			gameBuildVersion: "test",
		});
		expect(result).toEqual({ status: "pending", reason: "SIMULATOR_NOT_REGISTERED" });
	});

	it("accepts generic trace events in trusted mode and applies production security settings", async () => {
		await postJson("/v1/games/api-game/players", {
			player_id: "api-player-session",
			display_name: "Session Player",
		});
		const genericSession = await issueRunSession("api-player-session");
		const genericRun = {
			...validApiRun(genericSession, "api-player-session", 10, "Session Player"),
			input_trace: [{ type: "button_pressed", t_ms: 100, data: { button: "boost" } }],
		};
		const response = await postJson("/v1/games/api-game/runs", genericRun);
		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({
			verification_status: "accepted",
			verification_code: "TRUSTED_SUBMISSION",
		});

		expect(await tokenMatches("secret", "secret")).toBe(true);
		expect(await tokenMatches("secret", "different")).toBe(false);
		expect(getRateLimits({} as never)).toEqual({
			sessionsPerHour: 20,
			submissionsPerHour: 30,
			leaderboardPerMinute: 60,
			mobileAccessTokenTtlSeconds: 900,
		});
		expect(
			getRateLimits({
				SESSION_RATE_LIMIT_PER_HOUR: "2000",
				SUBMISSION_RATE_LIMIT_PER_HOUR: "45",
				LEADERBOARD_RATE_LIMIT_PER_MINUTE: "invalid",
			} as never),
		).toEqual({
			sessionsPerHour: 1000,
			submissionsPerHour: 45,
			leaderboardPerMinute: 60,
			mobileAccessTokenTtlSeconds: 900,
		});
	});

	it("exchanges platform auth for scoped mobile sessions and accepts bearerless submissions", async () => {
		await postJson("/v1/games/api-game/players", {
			player_id: "mobile-player",
			display_name: "Mobile Player",
		});
		await postJson("/v1/games/api-game/players", {
			player_id: "other-mobile-player",
			display_name: "Other Mobile Player",
		});

		const mobileToken = await issueMobileAccessToken("mobile-player");
		expect(mobileToken.access_token).toHaveLength(43);
		expect(mobileToken.player_id).toBe("mobile-player");
		expect(mobileToken.expires_at).toBeGreaterThan(now());
		expect(mobileToken.expires_in).toBe(900);

		const sessionResponse = await SELF.fetch(apiUrl("/v1/mobile/games/api-game/run-sessions"), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				Authorization: `Bearer ${mobileToken.access_token}`,
			},
			body: JSON.stringify({
				player_id: "mobile-player",
				ruleset_version: "api-v1",
				game_build_version: "mobile-test",
			}),
		});
		expect(sessionResponse.status).toBe(201);
		const session = (await sessionResponse.json()) as {
			run_id: string;
			session_token: string;
			nonce: string;
			run_seed: number;
		};

		const submission = await SELF.fetch(apiUrl("/v1/mobile/games/api-game/runs"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				...validApiRun(session, "mobile-player", 10, "Mobile Player"),
				game_build_version: "mobile-test",
			}),
		});
		expect(submission.status).toBe(201);
		expect(await submission.json()).toMatchObject({
			ok: true,
			verification_status: "accepted",
			verification_code: "TRUSTED_SUBMISSION",
		});

		const replayedToken = await SELF.fetch(apiUrl("/v1/mobile/games/api-game/run-sessions"), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				Authorization: `Bearer ${mobileToken.access_token}`,
			},
			body: JSON.stringify({
				player_id: "mobile-player",
				ruleset_version: "api-v1",
				game_build_version: "mobile-test",
			}),
		});
		expect(replayedToken.status).toBe(201);

		const wrongScope = await SELF.fetch(apiUrl("/v1/mobile/games/api-game/run-sessions"), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				Authorization: `Bearer ${mobileToken.access_token}`,
			},
			body: JSON.stringify({
				player_id: "other-mobile-player",
				ruleset_version: "api-v1",
				game_build_version: "mobile-test",
			}),
		});
		expect(wrongScope.status).toBe(403);
		expect(await wrongScope.json()).toMatchObject({
			ok: false,
			error: { code: "MOBILE_ACCESS_SCOPE_MISMATCH" },
		});
	});

	it("provisions a mobile player and derives player identity from the session", async () => {
		const mobileToken = await issueMobileAccessToken();
		expect(mobileToken.player_id).toMatch(/^mobile-[0-9a-f-]{36}$/);
		expect(mobileToken.name).toMatch(/^Mobile [0-9a-f]{8}$/);

		const sessionResponse = await SELF.fetch(apiUrl("/v1/mobile/games/api-game/run-sessions"), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				Authorization: `Bearer ${mobileToken.access_token}`,
			},
			body: JSON.stringify({
				ruleset_version: "api-v1",
				game_build_version: "mobile-auto-player",
			}),
		});
		expect(sessionResponse.status).toBe(201);
		const session = (await sessionResponse.json()) as {
			run_id: string;
			session_token: string;
			nonce: string;
			run_seed: number;
		};

		const { player_id: _ignoredPlayerId, ...runWithoutPlayerId } = validApiRun(
			{ ...session, session_token: session.session_token },
			mobileToken.player_id,
			10,
			mobileToken.name,
		);
		const submission = await SELF.fetch(apiUrl("/v1/mobile/games/api-game/runs"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				...runWithoutPlayerId,
				game_build_version: "mobile-auto-player",
			}),
		});
		expect(submission.status).toBe(201);
		expect(await submission.json()).toMatchObject({
			ok: true,
			verification_status: "accepted",
			verification_code: "TRUSTED_SUBMISSION",
		});
	});

	it("binds an explicitly supplied mobile display name through session validation", async () => {
		const playerId = "mobile-paquito";
		const initialToken = await postJson("/v1/mobile/games/api-game/access-tokens", { player_id: playerId });
		expect(initialToken.status).toBe(201);
		expect((await initialToken.json()) as { name: string }).toMatchObject({
			name: expect.stringMatching(/^Mobile [0-9a-f]{8}$/),
		});

		const namedTokenResponse = await postJson("/v1/mobile/games/api-game/access-tokens", {
			player_id: playerId,
			display_name: "Paquito",
		});
		expect(namedTokenResponse.status).toBe(201);
		const namedToken = (await namedTokenResponse.json()) as {
			access_token: string;
			name: string;
		};
		expect(namedToken.name).toBe("Paquito");

		const renamedMobile = await SELF.fetch(apiUrl("/v1/mobile/games/api-game/players/mobile-paquito"), {
			method: "PATCH",
			headers: {
				"content-type": "application/json",
				Authorization: `Bearer ${namedToken.access_token}`,
			},
			body: JSON.stringify({ display_name: "Paquito Renamed" }),
		});
		expect(renamedMobile.status).toBe(200);
		expect(await renamedMobile.json()).toMatchObject({
			ok: true,
			player_id: playerId,
			name: "Paquito Renamed",
		});

		const renamedOtherMobile = await SELF.fetch(apiUrl("/v1/mobile/games/api-game/players/other-mobile"), {
			method: "PATCH",
			headers: {
				"content-type": "application/json",
				Authorization: `Bearer ${namedToken.access_token}`,
			},
			body: JSON.stringify({ display_name: "Other Player" }),
		});
		expect(renamedOtherMobile.status).toBe(403);

		const sessionResponse = await SELF.fetch(apiUrl("/v1/mobile/games/api-game/run-sessions"), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				Authorization: `Bearer ${namedToken.access_token}`,
			},
			body: JSON.stringify({
				ruleset_version: "api-v1",
				game_build_version: "mobile-paquito",
			}),
		});
		expect(sessionResponse.status).toBe(201);
		const session = (await sessionResponse.json()) as {
			run_id: string;
			session_token: string;
			nonce: string;
			run_seed: number;
		};

		const submission = await SELF.fetch(apiUrl("/v1/mobile/games/api-game/runs"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				...validApiRun(session, playerId, 11, "Paquito Renamed"),
				game_build_version: "mobile-paquito",
			}),
		});
		expect(submission.status).toBe(201);
		expect(await submission.json()).toMatchObject({
			ok: true,
			verification_status: "accepted",
			verification_code: "TRUSTED_SUBMISSION",
		});
	});

	it("requires the simulator result to match every submitted statistic", () => {
		const stats: ReplayStats = {
			score: 12,
			game_stats: { jumps: 5, near_misses: 2, highest_combo: 3, double_gum: 1 },
		};
		expect(replayStatsMatch(stats, { ...stats, game_stats: { ...stats.game_stats, double_gum: 2 } })).toBe(false);
		expect(replayStatsMatch(stats, { ...stats, game_stats: { ...stats.game_stats, double_gum: 1 } })).toBe(true);
	});

	it("translates the Jumpy replay contract into platform replay evidence", () => {
		const translated = translateJumpyReplayContract({
			contract_version: 1,
			game_id: "jumpy-chewie",
			ruleset_version: "jumpy-chewie-2",
			game_build_version: "0.1.0",
			run_seed: 7,
			run_mode: "normal",
			simulation_timestep_ms: 8,
			run_duration_ms: 40,
			input_trace: [
				{ type: "swipe", timestamp_ms: 0, direction: "up" },
				{ type: "pickup_tap", timestamp_ms: 8, pickup_id: 12 },
				{ type: "pause", timestamp_ms: 16 },
				{ type: "resume", timestamp_ms: 24 },
			],
		});

		expect(translated).toMatchObject({ ok: true });
		if (!translated.ok) return;
		expect(translated.replay.replayDurationMs).toBe(40);
		expect(translated.replay.inputTrace).toEqual([
			{ type: "swipe", t_ms: 0, direction: "up" },
			{ type: "tap_pickup", t_ms: 8, pickup_id: "12" },
			{ type: "pause", t_ms: 16 },
			{ type: "resume", t_ms: 24 },
		]);

		const normalized = normalizeReplayInputTrace([
			{ type: "swipe", timestamp_ms: 0, direction: "up" },
			{ type: "action", t_ms: 8, data: { action: "jump" } },
		]);
		expect(normalized).toEqual([
			{ type: "swipe", t_ms: 0, direction: "up" },
			{ type: "action", t_ms: 8, data: { action: "jump" } },
		]);
	});

	it("rejects invalid Jumpy replay contract timing and pause transitions", () => {
		const result = translateJumpyReplayContract({
			contract_version: 1,
			game_id: "jumpy-chewie",
			ruleset_version: "jumpy-chewie-2",
			game_build_version: "0.1.0",
			run_seed: 7,
			run_mode: "normal",
			simulation_timestep_ms: 8,
			run_duration_ms: 32,
			input_trace: [
				{ type: "pause", timestamp_ms: 8 },
				{ type: "pause", timestamp_ms: 16 },
			],
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.issues.map((issue) => issue.message)).toContain("run cannot pause while already paused");
	});

	it("normalizes Jumpy-shaped evidence before storing a run", async () => {
		await postJson("/v1/games/api-game/players", {
			player_id: "api-player-jumpy-translation",
			display_name: "Jumpy Translate",
		});
		const session = await issueRunSession("api-player-jumpy-translation");
		const body = {
			...validApiRun(session, "api-player-jumpy-translation", 10, "Jumpy Translate"),
			run_duration: 1,
			game_stats: { run_duration_ms: 2400, score: 10 },
			input_trace: [
				{ type: "swipe", timestamp_ms: 0, direction: "right" },
				{ type: "pickup_tap", timestamp_ms: 1600, pickup_id: 7 },
			],
		};

		const response = await postJson("/v1/games/api-game/runs", body);
		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({
			verification_status: "accepted",
			verification_code: "TRUSTED_SUBMISSION",
		});

		const stored = await env.DB
			.prepare("SELECT run_duration, input_trace FROM runs WHERE run_id = ?")
			.bind(body.run_id)
			.first<{ run_duration: number; input_trace: string }>();
		expect(stored?.run_duration).toBe(1);
		expect(JSON.parse(stored?.input_trace ?? "[]")).toEqual([
			{ type: "swipe", t_ms: 0, direction: "right" },
			{ type: "tap_pickup", t_ms: 1600, pickup_id: "7" },
		]);
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

	it("removes a player and their game-scoped leaderboard data", async () => {
		const playerId = "api-player-removal";
		await postJson("/v1/games/api-game/players", {
			player_id: playerId,
			display_name: "Removal Player",
		});
		await issueMobileAccessToken(playerId);
		await issueRunSession(playerId);
		await insertRun("api-player-removal-run", "game-api", playerId, "api-v1", 99);

		const removed = await SELF.fetch(apiUrl(`/v1/games/api-game/players/${playerId}`), {
			method: "DELETE",
		});
		expect(removed.status).toBe(200);
		expect(await removed.json()).toEqual({ ok: true, player_id: playerId, removed: true });

		const board = await SELF.fetch(
			apiUrl("/v1/games/api-game/leaderboards/all_time?ruleset_version=api-v1"),
		);
		expect((await board.json()).entries).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ player_id: playerId })]),
		);

		const dependentRows = await env.DB
			.prepare(
				`SELECT
					(SELECT COUNT(*) FROM game_players WHERE game_id = ? AND player_id = ?) AS memberships,
					(SELECT COUNT(*) FROM runs WHERE game_id = ? AND player_id = ?) AS runs,
					(SELECT COUNT(*) FROM run_sessions WHERE game_id = ? AND player_id = ?) AS sessions,
					(SELECT COUNT(*) FROM mobile_access_tokens WHERE game_id = ? AND player_id = ?) AS tokens`,
			)
			.bind("game-api", playerId, "game-api", playerId, "game-api", playerId, "game-api", playerId)
			.first();
		expect(dependentRows).toEqual({ memberships: 0, runs: 0, sessions: 0, tokens: 0 });

		const reRegistered = await postJson("/v1/games/api-game/players", {
			player_id: playerId,
			display_name: "Rejoined Player",
		});
		expect(reRegistered.status).toBe(201);
	});

	it("removes a player through the mobile broker without a platform bearer", async () => {
		const playerId = "mobile-player-removal";
		const token = await issueMobileAccessToken(playerId);
		await insertRun("mobile-player-removal-run", "game-api", playerId, "api-v1", 77);

		const removed = await SELF.fetch(apiUrl(`/v1/mobile/games/api-game/players/${playerId}`), {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token.access_token}` },
		});
		expect(removed.status).toBe(200);
		expect(await removed.json()).toEqual({ ok: true, player_id: playerId, removed: true });

		const board = await SELF.fetch(
			apiUrl("/v1/public/games/api-game/leaderboards/all_time?ruleset_version=api-v1"),
		);
		expect((await board.json()).entries).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ player_id: playerId })]),
		);
	});

	it("accepts the completed game's player and run-session payloads", async () => {
		const created = await postJson("/v1/games/jumpy-chewie/players", {
			player_id: "jumpy-http-contract-player",
			name: "Jumpy Contract",
		});
		expect(created.status).toBe(201);
		expect(await created.json()).toEqual({
			ok: true,
			player_id: "jumpy-http-contract-player",
			name: "Jumpy Contract",
			created: true,
		});

		const renamed = await SELF.fetch(apiUrl("/v1/games/jumpy-chewie/players/jumpy-http-contract-player"), {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "Jumpy Renamed" }),
		});
		expect(renamed.status).toBe(200);
		expect(await renamed.json()).toMatchObject({ name: "Jumpy Renamed" });

		const session = await postJson("/v1/games/jumpy-chewie/run-sessions", {
			player_id: "jumpy-http-contract-player",
			ruleset_version: "jumpy-chewie-2",
			game_build_version: "0.1.0",
			run_mode: "normal",
			simulation_timestep_ms: 8,
		});
		expect(session.status).toBe(201);
		expect(await session.json()).toMatchObject({
			ok: true,
			ruleset_version: "jumpy-chewie-2",
			game_build_version: "0.1.0",
		});
	});

	it("releases unaccepted names but reserves names with accepted scores", async () => {
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

		const reused = await SELF.fetch(apiUrl("/v1/games/api-game/players/api-player-rename"), {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ display_name: "Taken Player" }),
		});
		expect(reused.status).toBe(200);
		expect(await reused.json()).toMatchObject({ ok: true, name: "Taken Player" });
		const released = await env.DB
			.prepare("SELECT display_name FROM game_players WHERE game_id = ? AND player_id = ?")
			.bind("game-api", "api-player-rename-other")
			.first<{ display_name: string }>();
		expect(released?.display_name).toMatch(/^Mobile [0-9a-f]{8}$/);

		await postJson("/v1/games/api-game/players", {
			player_id: "api-player-accepted-name",
			display_name: "Accepted Player",
		});
		await insertRun("accepted-name-reservation", "game-api", "api-player-accepted-name", "api-v1");
		const conflict = await SELF.fetch(apiUrl("/v1/games/api-game/players/api-player-rename"), {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ display_name: "Accepted Player" }),
		});
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toMatchObject({
			ok: false,
			error: { code: "PLAYER_NAME_CONFLICT", message: "That name is already used by a player with an accepted score" },
		});
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
			verification_status: "accepted",
			verification_code: "TRUSTED_SUBMISSION",
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
		expect(await tutorial.json()).toMatchObject({
			error: {
				message: "Only normal runs may be submitted",
				details: { phase: "run_validator", validator_key: "generic" },
			},
		});

		const board = await SELF.fetch(
			apiUrl("/v1/games/api-game/leaderboards/all_time?ruleset_version=api-v1&player_id=api-player-runs"),
		);
		expect(board.status).toBe(200);
		expect((await board.json()).entries.map((entry: { score: number }) => entry.score)).toEqual([10]);
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

	it("accepts a mobile access token for leaderboard reads", async () => {
		const playerId = "mobile-board-player";
		const tokenResponse = await postJson("/v1/mobile/games/api-game/access-tokens", {
			player_id: playerId,
			display_name: "Board Player",
		});
		expect(tokenResponse.status).toBe(201);
		const token = (await tokenResponse.json()) as { access_token: string };
		await insertRun("mobile-board-run", "game-api", playerId, "api-v1", 41);

		const response = await SELF.fetch(
			apiUrl("/v1/games/api-game/leaderboards/all_time?ruleset_version=api-v1&player_id=mobile-board-player"),
			{
				headers: { Authorization: `Bearer ${token.access_token}` },
			},
		);
		expect(response.status).toBe(200);
		expect((await response.json()).entries).toMatchObject([
			{ player_id: playerId, name: "Board Player", score: 41 },
		]);
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

	it("revalidates stored pending runs when the simulator becomes available", async () => {
		await env.DB.batch([
			env.DB.prepare("INSERT OR IGNORE INTO players (id) VALUES (?)").bind("api-player-revalidation"),
			env.DB
				.prepare("INSERT OR IGNORE INTO game_players (game_id, player_id, display_name) VALUES (?, ?, ?)")
				.bind("game-api", "api-player-revalidation", "Revalidation Player"),
		]);
		await insertRun("pending-revalidation-run", "game-api", "api-player-revalidation", "api-v1", 10, "pending");
		replayValidatorRegistry.register("game-api", "api-v1", "test", {
			validate: async (input) => ({
				status: "accepted",
				reason: "AUTHORITATIVE_REPLAY_MATCH",
				stats: { score: input.run.score, game_stats: input.run.game_stats },
			}),
		});

		try {
			await expect(revalidatePendingRuns(env.DB, env, 10)).resolves.toMatchObject({
				processed: 1,
				accepted: 1,
				still_pending: 0,
			});
			expect(
				await env.DB.prepare("SELECT verification_status FROM runs WHERE run_id = ?")
					.bind("pending-revalidation-run")
					.first(),
			).toEqual({ verification_status: "accepted" });
		} finally {
			replayValidatorRegistry.remove("game-api", "api-v1", "test");
		}
	});

	it("accepts only exact replays from the registered Cloud Hopper adapter", async () => {
		await postJson("/v1/games/cloud-hopper/players", {
			player_id: "reference-player",
			display_name: "Reference Player",
		});

		const session = await issueRunSessionFor(
			"cloud-hopper",
			"reference-player",
			"cloud-hopper-1",
			"reference-1",
		);
		const exactRun = {
			run_id: session.run_id,
			player_id: "reference-player",
			name: "Reference Player",
			ruleset_version: "cloud-hopper-1",
			score: 3,
			run_seed: session.run_seed,
			run_duration: 1,
			game_build_version: "reference-1",
			run_mode: "normal",
			client_completed_at: now(),
			game_stats: { actions: 3 },
			session_token: session.session_token,
			session_nonce: session.nonce,
			input_trace: [
				{ type: "action", t_ms: 100, data: { action: "jump" } },
				{ type: "action", t_ms: 200, data: { action: "jump" } },
				{ type: "action", t_ms: 300, data: { action: "jump" } },
			],
		};

		const accepted = await postJson("/v1/games/cloud-hopper/runs", exactRun);
		expect(accepted.status).toBe(201);
		expect(await accepted.json()).toMatchObject({
			verification_status: "accepted",
			verification_code: "REPLAY_VALIDATED",
		});

		const mismatchSession = await issueRunSessionFor(
			"cloud-hopper",
			"reference-player",
			"cloud-hopper-1",
			"reference-1",
		);
		const mismatched = await postJson("/v1/games/cloud-hopper/runs", {
			...exactRun,
			run_id: mismatchSession.run_id,
			session_token: mismatchSession.session_token,
			session_nonce: mismatchSession.nonce,
			run_seed: mismatchSession.run_seed,
			score: 4,
			game_stats: { actions: 4 },
		});
		expect(mismatched.status).toBe(201);
		expect(await mismatched.json()).toMatchObject({
			verification_status: "rejected",
			verification_code: "REPLAY_VALIDATION_REJECTED",
		});

		const unsupportedSession = await issueRunSessionFor(
			"cloud-hopper",
			"reference-player",
			"cloud-hopper-1",
			"reference-1",
		);
		const unsupported = await postJson("/v1/games/cloud-hopper/runs", {
			...exactRun,
			run_id: unsupportedSession.run_id,
			session_token: unsupportedSession.session_token,
			session_nonce: unsupportedSession.nonce,
			run_seed: unsupportedSession.run_seed,
			input_trace: [{ type: "pause", t_ms: 100 }],
			score: 1,
			game_stats: { actions: 1 },
		});
		expect(unsupported.status).toBe(201);
		expect(await unsupported.json()).toMatchObject({
			verification_status: "rejected",
			verification_code: "REPLAY_VALIDATION_REJECTED",
		});

		const board = await SELF.fetch(
			apiUrl("/v1/games/cloud-hopper/leaderboards/all_time?ruleset_version=cloud-hopper-1&player_id=reference-player"),
		);
		const payload = (await board.json()) as {
			entries: Array<{ player_id: string; score: number }>;
		};
		expect(payload.entries.find((entry) => entry.player_id === "reference-player")).toMatchObject({
			player_id: "reference-player",
			score: 3,
		});
	});
});
