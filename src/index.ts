import { Hono } from "hono";
import { checkDatabase } from "./db";
import { leaderboardRoutes } from "./routes/leaderboards";
import { playerRoutes } from "./routes/players";
import { runRoutes } from "./routes/runs";

const app = new Hono<{ Bindings: Env }>();

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

app.route("/v1", playerRoutes);
app.route("/v1", runRoutes);
app.route("/v1", leaderboardRoutes);

export default app satisfies ExportedHandler<Env>;
