import type { Context } from "hono";
import type { AppEnv } from "./types";

type ErrorStatus = 400 | 404 | 409 | 422 | 429 | 500;

export function jsonError(
	c: Context<AppEnv>,
	status: ErrorStatus,
	code: string,
	message: string,
	details?: unknown,
) {
	return c.json(
		{
			ok: false,
			error: {
				code,
				message,
				...(details === undefined ? {} : { details }),
			},
		},
		status,
	);
}

export async function readJson(c: Context<AppEnv>): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		return undefined;
	}
}
