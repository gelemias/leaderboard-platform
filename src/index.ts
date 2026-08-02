import { Hono } from "hono";
import { checkDatabase } from "./db";

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

export default app satisfies ExportedHandler<Env>;
