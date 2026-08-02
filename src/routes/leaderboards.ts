import { Hono } from "hono";
import { consumeRateLimit, getGameBySlug, getRuleset } from "../db";
import { getPeriodBounds, isLeaderboardPeriod, type LeaderboardPeriod } from "../domain/period";
import { jsonError } from "../http";
import type { AppEnv } from "../types";
import { z } from "zod";

const querySchema = z.object({
	ruleset_version: z.string().min(1).max(128),
	player_id: z.string().min(1).max(128).optional(),
	top_limit: z.coerce.number().int().min(1).max(100).default(10),
	nearby_limit: z.coerce.number().int().min(0).max(10).default(2),
});

type LeaderboardRow = {
	run_id: string;
	player_id: string;
	name: string;
	score: number;
	server_received_at: number;
};

export const leaderboardRoutes = new Hono<AppEnv>();

leaderboardRoutes.get("/games/:slug/leaderboards/:period", async (c) => {
	const periodParam = c.req.param("period");
	if (!isLeaderboardPeriod(periodParam)) {
		return jsonError(c, 422, "INVALID_PERIOD", "Period must be today, this_week, or all_time");
	}
	const period = periodParam as LeaderboardPeriod;

	const parsed = querySchema.safeParse(c.req.query());
	if (!parsed.success) {
		return jsonError(c, 422, "INVALID_QUERY", "Leaderboard query is invalid", parsed.error.issues);
	}

	const game = await getGameBySlug(c.env.DB, c.req.param("slug"));
	if (!game || game.status !== "active") return jsonError(c, 404, "UNKNOWN_GAME", "Game was not found");

	const ruleset = await getRuleset(c.env.DB, game.id, parsed.data.ruleset_version);
	if (!ruleset || ruleset.eligible_for_leaderboard !== 1) {
		return jsonError(c, 422, "INELIGIBLE_RULESET", "Ruleset is not eligible for this leaderboard");
	}

	const rateSubject = parsed.data.player_id ?? c.req.header("CF-Connecting-IP") ?? "anonymous";
	const rate = await consumeRateLimit(c.env.DB, "refresh", rateSubject, 60, 60);
	if (!rate.allowed) {
		return jsonError(c, 429, "RATE_LIMITED", "Too many leaderboard refreshes; try again later", {
			reset_at: rate.resetAt,
		});
	}

	const serverNow = Math.floor(Date.now() / 1000);
	const bounds = getPeriodBounds(period, serverNow);
	const rows = await c.env.DB
		.prepare(
			`WITH player_runs AS (
				SELECT r.run_id, r.player_id, gp.display_name AS name, r.score, r.server_received_at,
					ROW_NUMBER() OVER (
						PARTITION BY r.player_id
						ORDER BY r.score DESC, r.server_received_at ASC, r.run_id ASC
					) AS player_best
				FROM runs r
				JOIN game_players gp ON gp.game_id = r.game_id AND gp.player_id = r.player_id
				WHERE r.game_id = ?
					AND r.ruleset_version = ?
					AND r.verification_status = 'accepted'
					AND r.server_received_at >= ?
			), best_runs AS (
				SELECT run_id, player_id, name, score, server_received_at
				FROM player_runs
				WHERE player_best = 1
			)
			SELECT run_id, player_id, name, score, server_received_at
			FROM best_runs
			ORDER BY score DESC, server_received_at ASC, player_id ASC`,
		)
		.bind(game.id, parsed.data.ruleset_version, bounds.start)
		.all<LeaderboardRow>();

	const ranked = rows.results.map((row, index) => ({ ...row, rank: index + 1 }));
	const currentIndex = parsed.data.player_id
		? ranked.findIndex((entry) => entry.player_id === parsed.data.player_id)
		: -1;
	const nearby =
		currentIndex < 0
			? []
			: ranked.slice(
					Math.max(0, currentIndex - parsed.data.nearby_limit),
					currentIndex + parsed.data.nearby_limit + 1,
			  );

	return c.json({
		ok: true,
		period,
		ruleset: parsed.data.ruleset_version,
		period_start: bounds.start,
		next_reset: bounds.nextReset,
		entries: ranked.slice(0, parsed.data.top_limit),
		nearby,
		current_rank: currentIndex < 0 ? 0 : currentIndex + 1,
		total_players: ranked.length,
		percentile: currentIndex < 0 || ranked.length === 0 ? 0 : (1 - currentIndex / ranked.length) * 100,
		refreshed_at: serverNow,
		server_now: serverNow,
	});
});
