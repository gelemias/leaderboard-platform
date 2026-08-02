import { Hono } from "hono";
import { consumeRateLimit, getGameBySlug, getGamePlayer, getRuleset } from "../db";
import { getRateLimits } from "../config";
import { createOpaqueToken, createRunSeed, sha256Hex } from "../crypto";
import { jsonError, readJson } from "../http";
import type { AppEnv } from "../types";
import { z } from "zod";

const runSessionRequestSchema = z
	.object({
		player_id: z.string().min(1).max(128),
		ruleset_version: z.string().min(1).max(128),
		game_build_version: z.string().min(1).max(128),
		run_mode: z.enum(["normal", "tutorial", "practice", "debug", "assisted"]).optional(),
		simulation_timestep_ms: z.number().int().positive().max(1000).optional(),
	})
	.strict();

export const runSessionRoutes = new Hono<AppEnv>();

runSessionRoutes.post("/games/:slug/run-sessions", async (c) => {
	const parsed = runSessionRequestSchema.safeParse(await readJson(c));
	if (!parsed.success) {
		return jsonError(c, 422, "INVALID_RUN_SESSION", "Run session request is invalid", parsed.error.issues);
	}

	const game = await getGameBySlug(c.env.DB, c.req.param("slug"));
	if (!game || game.status !== "active") return jsonError(c, 404, "UNKNOWN_GAME", "Game was not found");

	const { player_id: playerId, ruleset_version: rulesetVersion, game_build_version: gameBuildVersion } =
		parsed.data;
	const ruleset = await getRuleset(c.env.DB, game.id, rulesetVersion);
	if (!ruleset || ruleset.eligible_for_leaderboard !== 1) {
		return jsonError(c, 422, "INELIGIBLE_RULESET", "Ruleset is not eligible for this leaderboard");
	}

	const player = await getGamePlayer(c.env.DB, game.id, playerId);
	if (!player) return jsonError(c, 404, "UNKNOWN_PLAYER", "Player is not registered for this game");

	const rate = await consumeRateLimit(c.env.DB, "run-session", playerId, getRateLimits(c.env).sessionsPerHour, 3600);
	if (!rate.allowed) {
		return jsonError(c, 429, "RATE_LIMITED", "Too many run sessions; try again later", {
			reset_at: rate.resetAt,
		});
	}

	const issuedAt = Math.floor(Date.now() / 1000);
	const expiresAt = issuedAt + 30 * 60;
	const runId = crypto.randomUUID();
	const nonce = crypto.randomUUID();
	const sessionToken = createOpaqueToken();
	const tokenHash = await sha256Hex(sessionToken);
	const runSeed = createRunSeed();

	try {
		await c.env.DB.prepare(
			`INSERT INTO run_sessions (
				run_id, game_id, player_id, ruleset_version, game_build_version,
				run_seed, token_hash, nonce, issued_at, expires_at, status
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued')`,
		)
			.bind(
				runId,
				game.id,
				playerId,
				rulesetVersion,
				gameBuildVersion,
				runSeed,
				tokenHash,
				nonce,
				issuedAt,
				expiresAt,
			)
			.run();
	} catch {
		return jsonError(c, 500, "RUN_SESSION_UNAVAILABLE", "Could not issue a run session");
	}

	return c.json(
		{
			ok: true,
			run_id: runId,
			session_token: sessionToken,
			nonce,
			run_seed: runSeed,
			ruleset_version: rulesetVersion,
			game_build_version: gameBuildVersion,
			issued_at: issuedAt,
			expires_at: expiresAt,
		},
		201,
	);
});
