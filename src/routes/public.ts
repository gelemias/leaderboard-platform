import { Hono } from "hono";
import { getLeaderboard } from "./leaderboards";
import type { AppEnv } from "../types";

type GameCatalogRow = {
	slug: string;
	name: string;
	ruleset_version: string;
};

export const publicRoutes = new Hono<AppEnv>();

publicRoutes.get("/public/games", async (c) => {
	const rows = await c.env.DB
		.prepare(
			`SELECT g.slug, g.name, r.version AS ruleset_version
			 FROM games g
			 JOIN rulesets r ON r.game_id = g.id
			 WHERE g.status = 'active' AND r.eligible_for_leaderboard = 1
			 ORDER BY g.name COLLATE NOCASE ASC, r.version COLLATE NOCASE ASC`,
		)
		.all<GameCatalogRow>();

	const bySlug = new Map<string, { slug: string; name: string; rulesets: { version: string }[] }>();
	for (const row of rows.results) {
		const game = bySlug.get(row.slug) ?? { slug: row.slug, name: row.name, rulesets: [] };
		game.rulesets.push({ version: row.ruleset_version });
		bySlug.set(row.slug, game);
	}

	return c.json({
		ok: true,
		games: [...bySlug.values()],
		refreshed_at: Math.floor(Date.now() / 1000),
	});
});

publicRoutes.get("/public/games/:slug/leaderboards/:period", getLeaderboard);
