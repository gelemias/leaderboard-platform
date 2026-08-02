import { Hono } from "hono";
import { revalidatePendingRuns } from "../domain/revalidate-pending";
import type { AppEnv } from "../types";

export const replayValidationRoutes = new Hono<AppEnv>();

replayValidationRoutes.post("/replay-validation/revalidate", async (c) => {
	const rawLimit = Number(c.req.query("limit") ?? "25");
	const summary = await revalidatePendingRuns(c.env.DB, c.env, Number.isFinite(rawLimit) ? rawLimit : 25);
	return c.json({ ok: true, ...summary });
});
