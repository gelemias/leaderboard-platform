import { Hono } from "hono";
import { requirePlatformAuth } from "./auth";
import { checkDatabase } from "./db";
import { leaderboardRoutes } from "./routes/leaderboards";
import { playerRoutes } from "./routes/players";
import { runRoutes } from "./routes/runs";
import { runSessionRoutes } from "./routes/run-sessions";
import { mobileRoutes } from "./routes/mobile";
import { replayValidationRoutes } from "./routes/replay-validation";
import { revalidatePendingRuns } from "./domain/revalidate-pending";
import type { AppEnv } from "./types";
import "./domain/register-simulators";

const app = new Hono<AppEnv>();

app.get("/health", async (c) => {
	const database = await checkDatabase(c.env.DB);

	return c.json(
		{
			ok: true,
			service: "leaderboard-platform",
			database,
		},
		database.available ? 200 : 503,
	);
});

app.use("/v1/*", async (c, next) => {
	const pathname = new URL(c.req.url).pathname;
	const isMobileBrokerRoute = /^\/v1\/mobile\/games\/[^/]+\/(?:access-tokens|run-sessions|runs|leaderboards\/[^/]+)$/.test(
		pathname,
	);
	const isLeaderboardRoute = /^\/v1\/games\/[^/]+\/leaderboards\/[^/]+$/.test(pathname);
	return isMobileBrokerRoute || isLeaderboardRoute ? next() : requirePlatformAuth(c, next);
});

app.route("/v1", playerRoutes);
app.route("/v1", runRoutes);
app.route("/v1", runSessionRoutes);
app.route("/v1", leaderboardRoutes);
app.route("/v1", mobileRoutes);
app.route("/v1", replayValidationRoutes);

export default {
	fetch: app.fetch,
	async scheduled(_controller, env, ctx) {
		ctx.waitUntil(revalidatePendingRuns(env.DB, env, 25));
	},
} satisfies ExportedHandler<Env>;
