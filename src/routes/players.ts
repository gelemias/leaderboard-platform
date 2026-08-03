import { Hono } from "hono";
import type { Context } from "hono";
import { getGameBySlug, getGamePlayer } from "../db";
import { jsonError, readJson } from "../http";
import type { AppEnv } from "../types";
import { playerNameUpdateSchema, playerRegistrationSchema } from "../validation/player";

export const playerRoutes = new Hono<AppEnv>();

const TEMPORARY_NAME_PREFIX = "Mobile ";

/**
 * A name is reserved by an accepted score, not by an abandoned provisioning
 * row. Older provisioning rows can otherwise strand a name forever even
 * though they never appear on a leaderboard.
 */
export async function claimPlayerName(db: D1Database, gameId: string, playerId: string, displayName: string): Promise<boolean> {
	const conflict = await db
		.prepare(
			`SELECT gp.player_id,
					EXISTS (
						SELECT 1 FROM runs r
						WHERE r.game_id = gp.game_id
							AND r.player_id = gp.player_id
							AND r.verification_status = 'accepted'
					) AS has_accepted_run
			 FROM game_players gp
			 WHERE gp.game_id = ?
				 AND gp.player_id <> ?
				 AND gp.display_name = ? COLLATE NOCASE
			 LIMIT 1`,
		)
		.bind(gameId, playerId, displayName)
		.first<{ player_id: string; has_accepted_run: number }>();

	if (!conflict) return true;
	if (Number(conflict.has_accepted_run) === 1) return false;

	const temporaryName = `${TEMPORARY_NAME_PREFIX}${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
	await db
		.prepare("UPDATE game_players SET display_name = ?, updated_at = ? WHERE game_id = ? AND player_id = ?")
		.bind(temporaryName, Math.floor(Date.now() / 1000), gameId, conflict.player_id)
		.run();
	return true;
}

export async function updatePlayerName(c: Context<AppEnv>) {
	const parsed = playerNameUpdateSchema.safeParse(await readJson(c));
	if (!parsed.success) {
		return jsonError(c, 422, "INVALID_PLAYER", "Player name is invalid", parsed.error.issues);
	}

	const game = await getGameBySlug(c.env.DB, c.req.param("slug"));
	if (!game || game.status !== "active") return jsonError(c, 404, "UNKNOWN_GAME", "Game was not found");

	const playerId = c.req.param("playerId");
	const mobileToken = c.get("mobileAccessToken");
	if (mobileToken && mobileToken.player_id !== playerId) {
		return jsonError(c, 403, "MOBILE_ACCESS_SCOPE_MISMATCH", "Mobile access is scoped to another player");
	}
	const player = await getGamePlayer(c.env.DB, game.id, playerId);
	if (!player) return jsonError(c, 404, "UNKNOWN_PLAYER", "Player is not registered for this game");
	if (!(await claimPlayerName(c.env.DB, game.id, playerId, parsed.data.display_name))) {
		return jsonError(c, 409, "PLAYER_NAME_CONFLICT", "That name is already used by a player with an accepted score");
	}

	try {
		await c.env.DB
			.prepare("UPDATE game_players SET display_name = ?, updated_at = ? WHERE game_id = ? AND player_id = ?")
			.bind(parsed.data.display_name, Math.floor(Date.now() / 1000), game.id, playerId)
			.run();
	} catch {
		return jsonError(c, 409, "PLAYER_NAME_CONFLICT", "That display name is already used in this game");
	}

	return c.json({ ok: true, player_id: playerId, name: parsed.data.display_name });
}

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
	if (!(await claimPlayerName(c.env.DB, game.id, playerId, displayName))) {
		return jsonError(c, 409, "PLAYER_NAME_CONFLICT", "That name is already used by a player with an accepted score");
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

playerRoutes.patch("/games/:slug/players/:playerId", updatePlayerName);
