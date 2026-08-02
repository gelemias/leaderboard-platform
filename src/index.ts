import { Hono } from "hono";
import { requirePlatformAuth } from "./auth";
import { checkDatabase } from "./db";
import { leaderboardRoutes } from "./routes/leaderboards";
import { playerRoutes } from "./routes/players";
import { runRoutes } from "./routes/runs";
import { runSessionRoutes } from "./routes/run-sessions";
import { mobileRoutes } from "./routes/mobile";
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
	const isMobileSessionOrSubmission = /^\/v1\/mobile\/games\/[^/]+\/(?:run-sessions|runs)$/.test(pathname);
	return isMobileSessionOrSubmission ? next() : requirePlatformAuth(c, next);
});

app.route("/v1", playerRoutes);
app.route("/v1", runRoutes);
app.route("/v1", runSessionRoutes);
app.route("/v1", leaderboardRoutes);
app.route("/v1", mobileRoutes);

export default app satisfies ExportedHandler<Env>;
