import type { Context, Next } from "hono";
import { sha256Hex } from "./crypto";
import { jsonError } from "./http";
import type { AppEnv } from "./types";

function bearerToken(header: string | undefined): string | null {
	if (!header) return null;
	const [scheme, token, ...rest] = header.trim().split(/\s+/);
	return scheme?.toLowerCase() === "bearer" && token && rest.length === 0 ? token : null;
}

export async function tokenMatches(supplied: string, expected: string): Promise<boolean> {
	const [suppliedHash, expectedHash] = await Promise.all([sha256Hex(supplied), sha256Hex(expected)]);
	if (suppliedHash.length !== expectedHash.length) return false;
	let difference = 0;
	for (let index = 0; index < suppliedHash.length; index += 1) {
		difference |= suppliedHash.charCodeAt(index) ^ expectedHash.charCodeAt(index);
	}
	return difference === 0;
}

export async function requirePlatformAuth(c: Context<AppEnv>, next: Next) {
	const required = c.env.AUTH_REQUIRED === "true" || c.env.ENVIRONMENT === "production";
	const configuredToken = c.env.PLATFORM_API_TOKEN;
	if (!configuredToken) {
		return required
			? jsonError(c, 503, "AUTH_NOT_CONFIGURED", "Platform authentication is not configured")
			: next();
	}

	const suppliedToken = bearerToken(c.req.header("Authorization"));
	if (!suppliedToken || !(await tokenMatches(suppliedToken, configuredToken))) {
		return jsonError(c, 401, "UNAUTHORIZED", "A valid platform bearer token is required");
	}
	return next();
}
