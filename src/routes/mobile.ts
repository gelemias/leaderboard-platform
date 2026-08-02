import { Hono } from "hono";
import { requireMobileAccessToken, requirePlatformAuth } from "../auth";
import { consumeRateLimit, getGameBySlug, getGamePlayer } from "../db";
import { getRateLimits } from "../config";
import { createOpaqueToken, sha256Hex } from "../crypto";
import { jsonError, readJson } from "../http";
import type { AppEnv } from "../types";
import { issueRunSession } from "./run-sessions";
import { submitRun } from "./runs";
import { z } from "zod";

const mobileAccessTokenRequestSchema = z
	.object({ player_id: z.string().min(1).max(128) })
	.strict();

export const mobileRoutes = new Hono<AppEnv>();

// This route is intended for a trusted game/backend service. The platform bearer
// must never be embedded in a mobile app; the app receives only this short-lived,
// game/player-scoped access token.
mobileRoutes.post("/mobile/games/:slug/access-tokens", requirePlatformAuth, async (c) => {
	const parsed = mobileAccessTokenRequestSchema.safeParse(await readJson(c));
	if (!parsed.success) {
		return jsonError(c, 422, "INVALID_MOBILE_TOKEN_REQUEST", "Mobile token request is invalid", parsed.error.issues);
	}

	const slug = c.req.param("slug");
	if (!slug) return jsonError(c, 404, "UNKNOWN_GAME", "Game was not found");
	const game = await getGameBySlug(c.env.DB, slug);
	if (!game || game.status !== "active") return jsonError(c, 404, "UNKNOWN_GAME", "Game was not found");

	const player = await getGamePlayer(c.env.DB, game.id, parsed.data.player_id);
	if (!player) return jsonError(c, 404, "UNKNOWN_PLAYER", "Player is not registered for this game");

	const rate = await consumeRateLimit(
		c.env.DB,
		"mobile-access-token",
		`${game.id}:${player.player_id}`,
		getRateLimits(c.env).sessionsPerHour,
		3600,
	);
	if (!rate.allowed) {
		return jsonError(c, 429, "RATE_LIMITED", "Too many mobile token exchanges; try again later", {
			reset_at: rate.resetAt,
		});
	}

	const issuedAt = Math.floor(Date.now() / 1000);
	const expiresAt = issuedAt + getRateLimits(c.env).mobileAccessTokenTtlSeconds;
	const accessToken = createOpaqueToken();
	try {
		await c.env.DB.prepare(
			`INSERT INTO mobile_access_tokens (
				token_id, game_id, player_id, token_hash, issued_at, expires_at
			) VALUES (?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				crypto.randomUUID(),
				game.id,
				player.player_id,
				await sha256Hex(accessToken),
				issuedAt,
				expiresAt,
			)
			.run();
	} catch {
		return jsonError(c, 500, "MOBILE_TOKEN_UNAVAILABLE", "Could not issue a mobile access token");
	}

	return c.json(
		{
			ok: true,
			token_type: "Bearer",
			access_token: accessToken,
			game: slug,
			player_id: player.player_id,
			issued_at: issuedAt,
			expires_at: expiresAt,
		},
		201,
	);
});

mobileRoutes.post(
	"/mobile/games/:slug/run-sessions",
	requireMobileAccessToken,
	issueRunSession,
);

// A run submission is authorized by the one-time session_token and session_nonce
// in the body, so this mobile route intentionally does not accept a platform token.
mobileRoutes.post("/mobile/games/:slug/runs", submitRun);
