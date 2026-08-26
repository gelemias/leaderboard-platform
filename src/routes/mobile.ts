import { Hono } from "hono";
import type { Context, Next } from "hono";
import { requireMobileAccessToken } from "../auth";
import { consumeRateLimit, getGameBySlug, getGamePlayer } from "../db";
import { getRateLimits } from "../config";
import { createOpaqueToken, sha256Hex } from "../crypto";
import { jsonError, readJson } from "../http";
import type { AppEnv } from "../types";
import { issueRunSession } from "./run-sessions";
import { submitRun } from "./runs";
import { claimPlayerName, removePlayer, updatePlayerName } from "./players";
import { displayNameSchema } from "../validation/player";
import { z } from "zod";

const mobileAccessTokenRequestSchema = z
	.object({
		player_id: z.string().min(1).max(128).optional(),
		display_name: displayNameSchema.optional(),
	})
	.strict();

export const mobileRoutes = new Hono<AppEnv>();

// App-facing broker route. The app sends no Authorization header. The Worker
// owns PLATFORM_API_TOKEN server-side and returns only a short-lived scoped token.
mobileRoutes.post("/mobile/games/:slug/access-tokens", async (c) => {
	const authRequired = c.env.AUTH_REQUIRED === "true" || c.env.ENVIRONMENT === "production";
	if (authRequired && !c.env.PLATFORM_API_TOKEN) {
		return jsonError(c, 503, "MOBILE_BROKER_NOT_CONFIGURED", "The mobile token broker is not configured");
	}

	const parsed = mobileAccessTokenRequestSchema.safeParse(await readJson(c));
	if (!parsed.success) {
		return jsonError(c, 422, "INVALID_MOBILE_TOKEN_REQUEST", "Mobile token request is invalid", parsed.error.issues);
	}

	const slug = c.req.param("slug");
	if (!slug) return jsonError(c, 404, "UNKNOWN_GAME", "Game was not found");
	const game = await getGameBySlug(c.env.DB, slug);
	if (!game || game.status !== "active") return jsonError(c, 404, "UNKNOWN_GAME", "Game was not found");

	const playerId = parsed.data.player_id ?? `mobile-${crypto.randomUUID()}`;
	const existingPlayer = await getGamePlayer(c.env.DB, game.id, playerId);
	let player = existingPlayer;
	const requestedDisplayName = parsed.data.display_name;
	if (player && requestedDisplayName !== undefined && player.display_name !== requestedDisplayName) {
		// The broker request is the source of truth for the mobile identity. Keep
		// the game-scoped player binding aligned so later run validation accepts
		// the same name returned by this exchange.
		if (!(await claimPlayerName(c.env.DB, game.id, playerId, requestedDisplayName))) {
			return jsonError(c, 409, "PLAYER_NAME_CONFLICT", "That name is already used by a player with an accepted score");
		}
		try {
			await c.env.DB.prepare(
				"UPDATE game_players SET display_name = ?, updated_at = ? WHERE game_id = ? AND player_id = ?",
			)
				.bind(requestedDisplayName, Math.floor(Date.now() / 1000), game.id, playerId)
				.run();
			player = await getGamePlayer(c.env.DB, game.id, playerId);
		} catch {
			return jsonError(c, 409, "PLAYER_PROVISION_CONFLICT", "Could not provision a player for this game");
		}
	}
	if (!player) {
		const displayName = requestedDisplayName ?? `Mobile ${crypto.randomUUID().slice(0, 8)}`;
		if (!(await claimPlayerName(c.env.DB, game.id, playerId, displayName))) {
			return jsonError(c, 409, "PLAYER_NAME_CONFLICT", "That name is already used by a player with an accepted score");
		}
		try {
			const timestamp = Math.floor(Date.now() / 1000);
			await c.env.DB.batch([
				c.env.DB.prepare(
					"INSERT OR IGNORE INTO players (id, created_at, updated_at) VALUES (?, ?, ?)",
				).bind(playerId, timestamp, timestamp),
				c.env.DB.prepare(
					"INSERT INTO game_players (game_id, player_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
				).bind(game.id, playerId, displayName, timestamp, timestamp),
			]);
			player = await getGamePlayer(c.env.DB, game.id, playerId);
		} catch {
			return jsonError(c, 409, "PLAYER_PROVISION_CONFLICT", "Could not provision a player for this game");
		}
	}
	if (!player) return jsonError(c, 500, "PLAYER_PROVISION_UNAVAILABLE", "Could not provision a player for this game");

	const rate = await consumeRateLimit(
		c.env.DB,
		"mobile-access-token",
		`${game.id}:${playerId}`,
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
				playerId,
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
			player_id: playerId,
			name: player.display_name,
			issued_at: issuedAt,
			expires_at: expiresAt,
			expires_in: expiresAt - issuedAt,
		},
		201,
	);
});

mobileRoutes.post(
	"/mobile/games/:slug/run-sessions",
	requireMobileAccessToken,
	issueRunSession,
);

// Name edits use the same scoped mobile token as run-session issuance. The
// handler verifies that the token player matches the URL player before writing.
mobileRoutes.patch(
	"/mobile/games/:slug/players/:playerId",
	requireMobileAccessToken,
	updatePlayerName,
);

// The app sends only its scoped mobile token. After authenticating and scoping
// that token, this delegates to the same removal handler used by the platform
// endpoint without exposing or requiring the platform bearer in the app.
mobileRoutes.delete(
	"/mobile/games/:slug/players/:playerId",
	requireMobileAccessToken,
	removePlayer,
);

const allowImplicitRunPlayer = async (c: Context<AppEnv>, next: Next) => {
	c.set("allowImplicitRunPlayer", true);
	return next();
};

const allowOfflineRun = async (c: Context<AppEnv>, next: Next) => {
	c.set("allowOfflineRun", true);
	return next();
};

// A run submission is authorized by the one-time session_token and session_nonce
// in the body, so this mobile route intentionally does not accept a platform token.
mobileRoutes.post("/mobile/games/:slug/runs", allowImplicitRunPlayer, submitRun);

// A cold-start offline run cannot have a server-issued one-time session. The
// scoped mobile token binds the deferred result to its durable player instead.
mobileRoutes.post(
	"/mobile/games/:slug/offline-runs",
	requireMobileAccessToken,
	allowImplicitRunPlayer,
	allowOfflineRun,
	submitRun,
);
