import type { Context, Next } from "hono";
import { sha256Hex } from "./crypto";
import { jsonError } from "./http";
import { getMobileAccessTokenByHash } from "./db";
import type { AppEnv } from "./types";

export function bearerToken(header: string | undefined): string | null {
	if (!header) return null;
	const [scheme, token, ...rest] = header.trim().split(/\s+/);
	return scheme?.toLowerCase() === "bearer" && token && rest.length === 0 ? token : null;
}

export async function requireMobileAccessToken(c: Context<AppEnv>, next: Next) {
	const suppliedToken = bearerToken(c.req.header("Authorization"));
	if (!suppliedToken) {
		return jsonError(c, 401, "MOBILE_AUTH_REQUIRED", "A valid mobile access token is required");
	}

	const token = await getMobileAccessTokenByHash(c.env.DB, await sha256Hex(suppliedToken));
	const serverNow = Math.floor(Date.now() / 1000);
	if (!token || token.revoked_at !== null || token.expires_at <= serverNow) {
		return jsonError(c, 401, "MOBILE_ACCESS_TOKEN_INVALID", "The mobile access token is invalid or expired");
	}

	c.set("mobileAccessToken", token);
	return next();
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
