import { Hono } from "hono";
import type { Context } from "hono";
import { requireMobileAccessToken } from "../auth";
import { getGameBySlug, getGamePlayer } from "../db";
import { sha256Hex } from "../crypto";
import { jsonError, readJson } from "../http";
import type { AppEnv } from "../types";
import { encryptPushToken } from "../domain/notifications";
import { z } from "zod";

const installationSchema = z
	.object({
		platform: z.enum(["ios", "android"]),
		provider: z.enum(["apns", "fcm"]),
		provider_environment: z.enum(["sandbox", "production"]).default("production"),
		token: z.string().trim().min(16).max(4096),
		notifications_enabled: z.boolean().default(false),
		rank_updates_enabled: z.boolean().default(false),
		admin_messages_enabled: z.boolean().default(false),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.provider === "apns" && value.platform !== "ios") {
			context.addIssue({ code: "custom", path: ["provider"], message: "APNs is only valid for iOS installations" });
		}
	});

const preferencesSchema = z
	.object({
		notifications_enabled: z.boolean().optional(),
		rank_updates_enabled: z.boolean().optional(),
		admin_messages_enabled: z.boolean().optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "At least one preference is required");

const campaignSchema = z
	.object({
		title: z.string().trim().min(1).max(120),
		body: z.string().trim().min(1).max(2000),
		data: z.record(z.string(), z.string()).default({}),
		audience: z.enum(["all_opted_in", "player_ids"]).default("all_opted_in"),
		player_ids: z.array(z.string().min(1).max(128)).max(1000).optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.audience === "player_ids" && (!value.player_ids || value.player_ids.length === 0)) {
			context.addIssue({ code: "custom", path: ["player_ids"], message: "player_ids is required for a player_ids audience" });
		}
		if (value.audience === "all_opted_in" && value.player_ids !== undefined) {
			context.addIssue({ code: "custom", path: ["player_ids"], message: "player_ids is only valid for a player_ids audience" });
		}
	});

export const notificationRoutes = new Hono<AppEnv>();
export const adminNotificationRoutes = new Hono<AppEnv>();

function escapedLike(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

async function gameForRequest(c: Context<AppEnv>) {
	const slug = c.req.param("slug");
	if (!slug) return null;
	return getGameBySlug(c.env.DB, slug);
}

async function assertMobileScope(c: Context<AppEnv>, gameId: string, playerId: string): Promise<boolean> {
	const mobileToken = c.get("mobileAccessToken");
	return Boolean(mobileToken && mobileToken.game_id === gameId && mobileToken.player_id === playerId);
}

notificationRoutes.put(
	"/mobile/games/:slug/push-installations/:installationId",
	requireMobileAccessToken,
	async (c) => {
		const parsed = installationSchema.safeParse(await readJson(c));
		if (!parsed.success) return jsonError(c, 422, "INVALID_PUSH_INSTALLATION", "Push installation is invalid", parsed.error.issues);
		const game = await gameForRequest(c);
		if (!game || game.status !== "active") return jsonError(c, 404, "UNKNOWN_GAME", "Game was not found");
		const mobileToken = c.get("mobileAccessToken");
		if (!mobileToken || !(await assertMobileScope(c, game.id, mobileToken.player_id))) {
			return jsonError(c, 403, "MOBILE_ACCESS_SCOPE_MISMATCH", "Mobile access is not scoped to this game");
		}
		const player = await getGamePlayer(c.env.DB, game.id, mobileToken.player_id);
		if (!player) return jsonError(c, 404, "UNKNOWN_PLAYER", "Player is not registered for this game");
		const installationId = c.req.param("installationId");
		if (!installationId || installationId.length > 128) return jsonError(c, 422, "INVALID_INSTALLATION_ID", "Installation ID is invalid");
		const now = Math.floor(Date.now() / 1000);
		try {
			await c.env.DB
				.prepare(
					`INSERT INTO push_installations
						(id, game_id, player_id, installation_id, platform, provider, provider_environment,
						 token_ciphertext, token_hash, notifications_enabled, rank_updates_enabled, admin_messages_enabled,
						 created_at, updated_at, last_seen_at, invalidated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
					 ON CONFLICT (game_id, installation_id) DO UPDATE SET
						player_id = excluded.player_id,
						platform = excluded.platform,
						provider = excluded.provider,
						provider_environment = excluded.provider_environment,
						token_ciphertext = excluded.token_ciphertext,
						token_hash = excluded.token_hash,
						notifications_enabled = excluded.notifications_enabled,
						rank_updates_enabled = excluded.rank_updates_enabled,
						admin_messages_enabled = excluded.admin_messages_enabled,
						updated_at = excluded.updated_at,
						last_seen_at = excluded.last_seen_at,
						invalidated_at = NULL`,
				)
				.bind(
					crypto.randomUUID(), game.id, player.player_id, installationId, parsed.data.platform, parsed.data.provider,
					parsed.data.provider_environment, await encryptPushToken(parsed.data.token, c.env), await sha256Hex(parsed.data.token),
					parsed.data.notifications_enabled ? 1 : 0, parsed.data.rank_updates_enabled ? 1 : 0,
					parsed.data.admin_messages_enabled ? 1 : 0, now, now, now,
				)
				.run();
		} catch (error) {
			console.warn("Push installation registration failed", { game_id: game.id, player_id: player.player_id, error });
			return jsonError(c, 409, "PUSH_INSTALLATION_CONFLICT", "Could not register this push installation");
		}
		return c.json({ ok: true, installation_id: installationId, player_id: player.player_id, updated_at: now });
	},
);

notificationRoutes.patch(
	"/mobile/games/:slug/push-installations/:installationId",
	requireMobileAccessToken,
	async (c) => {
		const parsed = preferencesSchema.safeParse(await readJson(c));
		if (!parsed.success) return jsonError(c, 422, "INVALID_PUSH_PREFERENCES", "Push preferences are invalid", parsed.error.issues);
		const game = await gameForRequest(c);
		const mobileToken = c.get("mobileAccessToken");
		if (!game || !mobileToken || !(await assertMobileScope(c, game.id, mobileToken.player_id)) ) {
			return jsonError(c, 403, "MOBILE_ACCESS_SCOPE_MISMATCH", "Mobile access is not scoped to this game");
		}
		const assignments: string[] = [];
		const values: unknown[] = [];
		if (parsed.data.notifications_enabled !== undefined) { assignments.push("notifications_enabled = ?"); values.push(parsed.data.notifications_enabled ? 1 : 0); }
		if (parsed.data.rank_updates_enabled !== undefined) { assignments.push("rank_updates_enabled = ?"); values.push(parsed.data.rank_updates_enabled ? 1 : 0); }
		if (parsed.data.admin_messages_enabled !== undefined) { assignments.push("admin_messages_enabled = ?"); values.push(parsed.data.admin_messages_enabled ? 1 : 0); }
		assignments.push("updated_at = ?"); values.push(Math.floor(Date.now() / 1000));
		values.push(game.id, mobileToken.player_id, c.req.param("installationId"));
		const result = await c.env.DB.prepare(
			`UPDATE push_installations SET ${assignments.join(", ")} WHERE game_id = ? AND player_id = ? AND installation_id = ?`,
		).bind(...values).run();
		if (result.meta.changes !== 1) return jsonError(c, 404, "UNKNOWN_PUSH_INSTALLATION", "Push installation was not found");
		return c.json({ ok: true, installation_id: c.req.param("installationId") });
	},
);

notificationRoutes.delete(
	"/mobile/games/:slug/push-installations/:installationId",
	requireMobileAccessToken,
	async (c) => {
		const game = await gameForRequest(c);
		const mobileToken = c.get("mobileAccessToken");
		if (!game || !mobileToken || !(await assertMobileScope(c, game.id, mobileToken.player_id))) {
			return jsonError(c, 403, "MOBILE_ACCESS_SCOPE_MISMATCH", "Mobile access is not scoped to this game");
		}
		const result = await c.env.DB.prepare(
			"DELETE FROM push_installations WHERE game_id = ? AND player_id = ? AND installation_id = ?",
		).bind(game.id, mobileToken.player_id, c.req.param("installationId")).run();
		if (result.meta.changes !== 1) return jsonError(c, 404, "UNKNOWN_PUSH_INSTALLATION", "Push installation was not found");
		return c.json({ ok: true, installation_id: c.req.param("installationId"), removed: true });
	},
);

adminNotificationRoutes.get("/admin/games/:slug/players", async (c) => {
	const game = await gameForRequest(c);
	if (!game || game.status !== "active") return jsonError(c, 404, "UNKNOWN_GAME", "Game was not found");

	const search = (c.req.query("search") ?? "").trim().slice(0, 100);
	const requestedLimit = Number.parseInt(c.req.query("limit") ?? "100", 10);
	const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 100;
	const searchClause = search ? "AND (gp.player_id LIKE ? ESCAPE '\\' OR gp.display_name LIKE ? ESCAPE '\\')" : "";
	const searchPattern = `%${escapedLike(search)}%`;
	const players = await c.env.DB
		.prepare(
			`SELECT gp.player_id, gp.display_name,
					COUNT(pi.id) AS installation_count,
					COALESCE(SUM(CASE WHEN pi.invalidated_at IS NULL
						AND pi.notifications_enabled = 1
						AND pi.admin_messages_enabled = 1 THEN 1 ELSE 0 END), 0) AS eligible_installation_count
				 FROM game_players gp
				 LEFT JOIN push_installations pi ON pi.game_id = gp.game_id AND pi.player_id = gp.player_id
				 WHERE gp.game_id = ? ${searchClause}
				 GROUP BY gp.player_id, gp.display_name
				 ORDER BY gp.display_name COLLATE NOCASE ASC, gp.player_id ASC
				 LIMIT ?`,
		)
		.bind(...(search ? [game.id, searchPattern, searchPattern, limit] : [game.id, limit]))
		.all<{
			player_id: string;
			display_name: string;
			installation_count: number;
			eligible_installation_count: number;
		}>();

	return c.json({
		ok: true,
		game: { slug: game.slug, name: game.name },
		players: players.results.map((player) => ({
			...player,
			installation_count: Number(player.installation_count),
			eligible_installation_count: Number(player.eligible_installation_count),
		})),
		limit,
		search,
	});
});

adminNotificationRoutes.get("/admin/session", (c) => {
	c.header("Cache-Control", "no-store");
	return c.json({ ok: true });
});

adminNotificationRoutes.post("/admin/games/:slug/notifications/campaigns", async (c) => {
	const parsed = campaignSchema.safeParse(await readJson(c));
	if (!parsed.success) return jsonError(c, 422, "INVALID_NOTIFICATION_CAMPAIGN", "Notification campaign is invalid", parsed.error.issues);
	const game = await gameForRequest(c);
	if (!game || game.status !== "active") return jsonError(c, 404, "UNKNOWN_GAME", "Game was not found");
	const campaignId = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);
	const playerIds = parsed.data.player_ids ?? [];
	const recipientQuery = parsed.data.audience === "all_opted_in"
		? `SELECT id, player_id FROM push_installations WHERE game_id = ? AND invalidated_at IS NULL AND notifications_enabled = 1 AND admin_messages_enabled = 1`
		: `SELECT id, player_id FROM push_installations WHERE game_id = ? AND invalidated_at IS NULL AND notifications_enabled = 1 AND admin_messages_enabled = 1 AND player_id IN (${playerIds.map(() => "?").join(",")})`;
	const recipients = await c.env.DB.prepare(recipientQuery).bind(game.id, ...playerIds).all<{ id: string; player_id: string }>();
	const statements = [c.env.DB.prepare(
		`INSERT INTO notification_campaigns (campaign_id, game_id, title, body, data_json, audience, created_by, status, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
	).bind(
		campaignId, game.id, parsed.data.title, parsed.data.body, JSON.stringify(parsed.data.data), parsed.data.audience,
		c.req.header("CF-Access-Authenticated-User-Email") ?? "platform-token", now,
	)];
	for (const recipient of recipients.results) {
		statements.push(c.env.DB.prepare(
			`INSERT OR IGNORE INTO notification_deliveries
				(delivery_id, installation_id, game_id, player_id, kind, campaign_id, dedupe_key, title, body, data_json, status, created_at)
			 VALUES (?, ?, ?, ?, 'admin_message', ?, ?, ?, ?, ?, 'pending', ?)`,
		).bind(
			crypto.randomUUID(), recipient.id, game.id, recipient.player_id, campaignId,
			`campaign:${campaignId}:${recipient.id}`, parsed.data.title, parsed.data.body, JSON.stringify(parsed.data.data), now,
		));
	}
	for (let offset = 0; offset < statements.length; offset += 100) await c.env.DB.batch(statements.slice(offset, offset + 100));
	return c.json({ ok: true, campaign_id: campaignId, recipients: recipients.results.length }, 201);
});

adminNotificationRoutes.get("/admin/notifications/campaigns/:campaignId", async (c) => {
	const campaign = await c.env.DB.prepare(
		`SELECT campaign_id, game_id, title, body, audience, created_by, status, created_at, completed_at,
			(SELECT COUNT(*) FROM notification_deliveries d WHERE d.campaign_id = c.campaign_id) AS total_deliveries,
			(SELECT COUNT(*) FROM notification_deliveries d WHERE d.campaign_id = c.campaign_id AND d.status = 'sent') AS sent_deliveries,
			(SELECT COUNT(*) FROM notification_deliveries d WHERE d.campaign_id = c.campaign_id AND d.status IN ('failed', 'skipped')) AS failed_deliveries
		 FROM notification_campaigns c WHERE campaign_id = ? LIMIT 1`,
	).bind(c.req.param("campaignId")).first();
	if (!campaign) return jsonError(c, 404, "UNKNOWN_NOTIFICATION_CAMPAIGN", "Notification campaign was not found");
	return c.json({ ok: true, campaign });
});
