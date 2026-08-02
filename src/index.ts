import { Hono } from "hono";
import { requirePlatformAuth } from "./auth";
import { checkDatabase } from "./db";
import { leaderboardRoutes } from "./routes/leaderboards";
import { playerRoutes } from "./routes/players";
import { runRoutes } from "./routes/runs";
import { runSessionRoutes } from "./routes/run-sessions";
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

app.use("/v1/*", requirePlatformAuth);

app.route("/v1", playerRoutes);
app.route("/v1", runRoutes);
app.route("/v1", runSessionRoutes);
app.route("/v1", leaderboardRoutes);

export default app satisfies ExportedHandler<Env>;
