import { Hono } from "hono";
import { getGameBySlug, getGamePlayer } from "../db";
import { jsonError, readJson } from "../http";
import type { AppEnv } from "../types";
import { playerNameUpdateSchema, playerRegistrationSchema } from "../validation/player";

export const playerRoutes = new Hono<AppEnv>();

playerRoutes.post("/games/:slug/players", async (c) => {
	const parsed = playerRegistrationSchema.safeParse(await readJson(c));
	if (!parsed.success) {
		return jsonError(c, 422, "INVALID_PLAYER", "Player registration is invalid", parsed.error.issues);
	}

	const game = await getGameBySlug(c.env.DB, c.req.param("slug"));
	if (!game || game.status !== "active") return jsonError(c, 404, "UNKNOWN_GAME", "Game was not found");

	const { player_id: playerId, display_name: displayName } = parsed.data;
	const existing = await getGamePlayer(c.env.DB, game.id, playerId);
	if (existing) {
		return c.json({ ok: true, player_id: playerId, name: existing.display_name, created: false });
	}

	try {
		const timestamp = Math.floor(Date.now() / 1000);
		await c.env.DB.batch([
			c.env.DB.prepare("INSERT OR IGNORE INTO players (id, created_at, updated_at) VALUES (?, ?, ?)").bind(
				playerId,
				timestamp,
				timestamp,
			),
			c.env.DB
				.prepare(
					"INSERT INTO game_players (game_id, player_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
				)
				.bind(game.id, playerId, displayName, timestamp, timestamp),
		]);
	} catch {
		return jsonError(c, 409, "PLAYER_NAME_CONFLICT", "That display name is already used in this game");
	}

	return c.json({ ok: true, player_id: playerId, name: displayName, created: true }, 201);
});

playerRoutes.patch("/games/:slug/players/:playerId", async (c) => {
	const parsed = playerNameUpdateSchema.safeParse(await readJson(c));
	if (!parsed.success) {
		return jsonError(c, 422, "INVALID_PLAYER", "Player name is invalid", parsed.error.issues);
	}

	const game = await getGameBySlug(c.env.DB, c.req.param("slug"));
	if (!game || game.status !== "active") return jsonError(c, 404, "UNKNOWN_GAME", "Game was not found");

	const playerId = c.req.param("playerId");
	const player = await getGamePlayer(c.env.DB, game.id, playerId);
	if (!player) return jsonError(c, 404, "UNKNOWN_PLAYER", "Player is not registered for this game");

	try {
		await c.env.DB
			.prepare("UPDATE game_players SET display_name = ?, updated_at = ? WHERE game_id = ? AND player_id = ?")
			.bind(parsed.data.display_name, Math.floor(Date.now() / 1000), game.id, playerId)
			.run();
	} catch {
		return jsonError(c, 409, "PLAYER_NAME_CONFLICT", "That display name is already used in this game");
	}

	return c.json({ ok: true, player_id: playerId, name: parsed.data.display_name });
});
