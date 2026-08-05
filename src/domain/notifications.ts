import { getPeriodBounds, type LeaderboardPeriod } from "./period";
import type {
	AppBindings,
	LeaderboardPositionRow,
	NotificationDeliveryRow,
	PushInstallationRow,
} from "../types";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type NotificationPayload = {
	title: string;
	body: string;
	data: Record<string, string>;
};

type RankedEntry = {
	player_id: string;
	name: string;
	score: number;
	rank: number;
};

type DeliveryResult =
	| { status: "sent" }
	| { status: "skipped"; reason: string }
	| { status: "invalid"; reason: string }
	| { status: "retry"; reason: string };

type JwtSigningAlgorithm = { name: string; hash?: string; namedCurve?: string };

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlText(value: string): string {
	return base64Url(textEncoder.encode(value));
}

function base64UrlToBytes(value: string): Uint8Array {
	const normalized = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
	const binary = atob(normalized);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function pemToBytes(pem: string): Uint8Array {
	return base64UrlToBytes(
		pem
			.replace(/-----BEGIN [^-]+-----/g, "")
			.replace(/-----END [^-]+-----/g, "")
			.replace(/\s+/g, "")
			.replaceAll("+", "-")
			.replaceAll("/", "_"),
	);
}

function json(value: unknown): string {
	return JSON.stringify(value);
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
	const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(secret));
	return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptPushToken(token: string, env: AppBindings): Promise<string> {
	if (!env.PUSH_TOKEN_ENCRYPTION_KEY) {
		if (env.ENVIRONMENT === "production") throw new Error("PUSH_TOKEN_ENCRYPTION_KEY is not configured");
		return `dev:${base64UrlText(token)}`;
	}
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const key = await encryptionKey(env.PUSH_TOKEN_ENCRYPTION_KEY);
	const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, textEncoder.encode(token));
	return `v1.${base64Url(iv)}.${base64Url(new Uint8Array(encrypted))}`;
}

export async function decryptPushToken(ciphertext: string, env: AppBindings): Promise<string> {
	if (ciphertext.startsWith("dev:")) return textDecoder.decode(base64UrlToBytes(ciphertext.slice(4)));
	const [version, ivText, payloadText] = ciphertext.split(".");
	if (version !== "v1" || !ivText || !payloadText || !env.PUSH_TOKEN_ENCRYPTION_KEY) {
		throw new Error("Push token ciphertext is unavailable");
	}
	const key = await encryptionKey(env.PUSH_TOKEN_ENCRYPTION_KEY);
	const decrypted = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: base64UrlToBytes(ivText) },
		key,
		base64UrlToBytes(payloadText),
	);
	return textDecoder.decode(decrypted);
}

export function acceptedRunEventStatement(
	db: D1Database,
	run: { run_id: string; game_id: string; ruleset_version: string },
) {
	return db
		.prepare(
			`INSERT OR IGNORE INTO notification_events
				(event_id, run_id, game_id, ruleset_version, status, attempts, created_at)
			 VALUES (?, ?, ?, ?, 'pending', 0, ?)` ,
		)
		.bind(crypto.randomUUID(), run.run_id, run.game_id, run.ruleset_version, Math.floor(Date.now() / 1000));
}

async function rankedEntries(
	db: D1Database,
	gameId: string,
	rulesetVersion: string,
	period: LeaderboardPeriod,
	serverNow: number,
): Promise<RankedEntry[]> {
	const bounds = getPeriodBounds(period, serverNow);
	const rows = await db
		.prepare(
			`WITH player_runs AS (
				SELECT r.player_id, gp.display_name AS name, r.score, r.server_received_at, r.run_id,
					ROW_NUMBER() OVER (
						PARTITION BY r.player_id
						ORDER BY r.score DESC, r.server_received_at ASC, r.run_id ASC
					) AS player_best
				FROM runs r
				JOIN game_players gp ON gp.game_id = r.game_id AND gp.player_id = r.player_id
				WHERE r.game_id = ? AND r.ruleset_version = ?
					AND r.verification_status = 'accepted' AND r.server_received_at >= ?
			), best_runs AS (
				SELECT player_id, name, score, server_received_at, run_id
				FROM player_runs WHERE player_best = 1
			)
			SELECT player_id, name, score
			FROM best_runs
			ORDER BY score DESC, server_received_at ASC, player_id ASC`,
		)
		.bind(gameId, rulesetVersion, bounds.start)
		.all<{ player_id: string; name: string; score: number }>();
	return rows.results.map((row, index) => ({ ...row, rank: index + 1 }));
}

async function previousPositions(
	db: D1Database,
	gameId: string,
	rulesetVersion: string,
	period: LeaderboardPeriod,
	periodStart: number,
): Promise<LeaderboardPositionRow[]> {
	return (
		await db
			.prepare(
				`SELECT game_id, ruleset_version, period, period_start, player_id, rank, score
				 FROM leaderboard_positions
				 WHERE game_id = ? AND ruleset_version = ? AND period = ? AND period_start = ?`,
			)
			.bind(gameId, rulesetVersion, period, periodStart)
			.all<LeaderboardPositionRow>()
	).results;
}

async function writePositions(
	db: D1Database,
	gameId: string,
	rulesetVersion: string,
	period: LeaderboardPeriod,
	periodStart: number,
	entries: RankedEntry[],
	now: number,
): Promise<void> {
	await db
		.prepare(
			`DELETE FROM leaderboard_positions
			 WHERE game_id = ? AND ruleset_version = ? AND period = ? AND period_start = ?`,
		)
		.bind(gameId, rulesetVersion, period, periodStart)
		.run();
	for (let offset = 0; offset < entries.length; offset += 100) {
		const statements = entries.slice(offset, offset + 100).map((entry) =>
			db
				.prepare(
					`INSERT INTO leaderboard_positions
						(game_id, ruleset_version, period, period_start, player_id, rank, score, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(gameId, rulesetVersion, period, periodStart, entry.player_id, entry.rank, entry.score, now),
		);
		if (statements.length > 0) await db.batch(statements);
	}
}

async function enqueueRankLoss(
	db: D1Database,
	gameId: string,
	rulesetVersion: string,
	period: LeaderboardPeriod,
	periodStart: number,
	previous: LeaderboardPositionRow,
	currentRank: number | null,
	now: number,
): Promise<void> {
	const installations = await db
		.prepare(
			`SELECT id, game_id, player_id
			 FROM push_installations
			 WHERE game_id = ? AND player_id = ? AND invalidated_at IS NULL
				 AND notifications_enabled = 1 AND rank_updates_enabled = 1`,
		)
		.bind(gameId, previous.player_id)
		.all<{ id: string; game_id: string; player_id: string }>();
	const toRank = currentRank ?? 0;
	const data = {
		event: "rank_lost",
		game_id: gameId,
		ruleset_version: rulesetVersion,
		period,
		from_rank: String(previous.rank),
		to_rank: String(toRank),
	};
	const title = `${period === "all_time" ? "All-time" : period === "this_week" ? "Weekly" : "Today"} leaderboard update`;
	const body = currentRank
		? `You moved from #${previous.rank} to #${currentRank}.`
		: `You are no longer ranked on this leaderboard.`;
	for (const installation of installations.results) {
		await db
			.prepare(
				`INSERT OR IGNORE INTO notification_deliveries
					(delivery_id, installation_id, game_id, player_id, kind, dedupe_key, title, body, data_json, status, created_at)
				 VALUES (?, ?, ?, ?, 'rank_lost', ?, ?, ?, ?, 'pending', ?)`,
			)
			.bind(
				crypto.randomUUID(),
				installation.id,
				installation.game_id,
				installation.player_id,
				`rank:${gameId}:${rulesetVersion}:${period}:${periodStart}:${previous.player_id}:${previous.rank}:${toRank}`,
				title,
				body,
				json(data),
				now,
			)
			.run();
	}
}

export async function reconcileLeaderboard(
	db: D1Database,
	gameId: string,
	rulesetVersion: string,
	serverNow = Math.floor(Date.now() / 1000),
): Promise<{ boards: number; rank_losses: number }> {
	let rankLosses = 0;
	for (const period of ["today", "this_week", "all_time"] as const) {
		const bounds = getPeriodBounds(period, serverNow);
		const current = await rankedEntries(db, gameId, rulesetVersion, period, serverNow);
		const previous = await previousPositions(db, gameId, rulesetVersion, period, bounds.start);
		if (previous.length > 0) {
			const currentRanks = new Map(current.map((entry) => [entry.player_id, entry.rank]));
			for (const oldPosition of previous) {
				const currentRank = currentRanks.get(oldPosition.player_id) ?? null;
				if (currentRank !== null && currentRank <= oldPosition.rank) continue;
				await enqueueRankLoss(db, gameId, rulesetVersion, period, bounds.start, oldPosition, currentRank, serverNow);
				rankLosses += 1;
			}
		}
		await writePositions(db, gameId, rulesetVersion, period, bounds.start, current, serverNow);
	}
	return { boards: 3, rank_losses: rankLosses };
}

type EventRow = {
	event_id: string;
	run_id: string;
	game_id: string;
	ruleset_version: string;
	attempts: number;
};

export async function processNotificationEvents(db: D1Database, limit = 25): Promise<number> {
	const events = (
		await db
			.prepare(
				`SELECT event_id, run_id, game_id, ruleset_version, attempts
				 FROM notification_events
				 WHERE status IN ('pending', 'processing')
				 ORDER BY created_at ASC LIMIT ?`,
			)
			.bind(Math.max(1, Math.min(100, Math.floor(limit))))
			.all<EventRow>()
	).results;
	let processed = 0;
	for (const event of events) {
		await db
			.prepare("UPDATE notification_events SET status = 'processing', attempts = attempts + 1 WHERE event_id = ?")
			.bind(event.event_id)
			.run();
		try {
			await reconcileLeaderboard(db, event.game_id, event.ruleset_version);
			await db
				.prepare("UPDATE notification_events SET status = 'reconciled', processed_at = ? WHERE event_id = ?")
				.bind(Math.floor(Date.now() / 1000), event.event_id)
				.run();
			processed += 1;
		} catch (error) {
			await db
				.prepare("UPDATE notification_events SET status = 'pending' WHERE event_id = ?")
				.bind(event.event_id)
				.run();
			console.error("Notification event processing failed", { event_id: event.event_id, error });
		}
	}
	return processed;
}

function derToRaw(signature: Uint8Array): Uint8Array {
	if (signature.length === 64 || signature[0] !== 0x30) return signature;
	let index = 2;
	if (signature[index] !== 0x02) return signature;
	const rLength = signature[index + 1];
	const r = signature.slice(index + 2, index + 2 + rLength);
	index += 2 + rLength;
	if (signature[index] !== 0x02) return signature;
	const sLength = signature[index + 1];
	const s = signature.slice(index + 2, index + 2 + sLength);
	const raw = new Uint8Array(64);
	r.slice(-32).forEach((byte, offset, values) => raw[32 - values.length + offset] = byte);
	s.slice(-32).forEach((byte, offset, values) => raw[64 - values.length + offset] = byte);
	return raw;
}

async function signJwt(
	header: Record<string, string>,
	claims: Record<string, string | number>,
	privateKey: string,
	algorithm: JwtSigningAlgorithm,
	importAlgorithm: JwtSigningAlgorithm,
	signatureFormat: "ecdsa" | "rsa",
	): Promise<string> {
	const encodedHeader = base64UrlText(json(header));
	const encodedClaims = base64UrlText(json(claims));
	const key = await crypto.subtle.importKey("pkcs8", pemToBytes(privateKey), importAlgorithm, false, ["sign"]);
	const signature = await crypto.subtle.sign(algorithm, key, textEncoder.encode(`${encodedHeader}.${encodedClaims}`));
	const signatureBytes = new Uint8Array(signature);
	return `${encodedHeader}.${encodedClaims}.${base64Url(signatureFormat === "ecdsa" ? derToRaw(signatureBytes) : signatureBytes)}`;
}

async function apnsProviderToken(env: AppBindings): Promise<string> {
	if (!env.APNS_TEAM_ID || !env.APNS_KEY_ID || !env.APNS_PRIVATE_KEY) throw new Error("APNs credentials are not configured");
	return signJwt(
		{ alg: "ES256", kid: env.APNS_KEY_ID, typ: "JWT" },
		{ iss: env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) },
		 env.APNS_PRIVATE_KEY,
		{ name: "ECDSA", hash: "SHA-256" },
		{ name: "ECDSA", namedCurve: "P-256" },
		"ecdsa",
	);
}

async function sendApns(
	installation: PushInstallationRow,
	payload: NotificationPayload,
	env: AppBindings,
	authToken: string,
): Promise<DeliveryResult> {
	if (!env.APNS_BUNDLE_ID) return { status: "skipped", reason: "APNS_BUNDLE_ID_NOT_CONFIGURED" };
	const token = await decryptPushToken(installation.token_ciphertext, env);
	const endpoint = installation.provider_environment === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
	const response = await fetch(`https://${endpoint}/3/device/${encodeURIComponent(token)}`, {
		method: "POST",
		headers: {
			authorization: `bearer ${authToken}`,
			"apns-topic": env.APNS_BUNDLE_ID,
			"apns-push-type": "alert",
			"apns-priority": "10",
			"content-type": "application/json",
		},
		body: json({ aps: { alert: { title: payload.title, body: payload.body }, sound: "default" }, ...payload.data }),
	});
	if (response.ok) return { status: "sent" };
	const responseBody = await response.text();
	if (response.status === 410 || responseBody.includes("Unregistered") || responseBody.includes("BadDeviceToken")) {
		return { status: "invalid", reason: `APNS_${response.status}` };
	}
	return { status: response.status >= 500 || response.status === 429 ? "retry" : "invalid", reason: `APNS_${response.status}` };
}

async function fcmAccessToken(env: AppBindings): Promise<{ token: string; projectId: string }> {
	if (!env.FCM_SERVICE_ACCOUNT_JSON) throw new Error("FCM credentials are not configured");
	const account = JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON) as { client_email?: string; private_key?: string; project_id?: string };
	if (!account.client_email || !account.private_key || !(account.project_id || env.FCM_PROJECT_ID)) {
		throw new Error("FCM service account is incomplete");
	}
	const assertion = await signJwt(
		{ alg: "RS256", typ: "JWT" },
		{
			iss: account.client_email,
			scope: "https://www.googleapis.com/auth/firebase.messaging",
			aud: "https://oauth2.googleapis.com/token",
			iat: Math.floor(Date.now() / 1000),
			exp: Math.floor(Date.now() / 1000) + 3600,
		},
		account.private_key,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		"rsa",
	);
	const response = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(assertion)}`,
	});
	if (!response.ok) throw new Error(`FCM_AUTH_${response.status}`);
	const token = (await response.json()) as { access_token?: string };
	if (!token.access_token) throw new Error("FCM access token missing");
	return { token: token.access_token, projectId: env.FCM_PROJECT_ID ?? account.project_id! };
}

async function sendFcm(
	installation: PushInstallationRow,
	payload: NotificationPayload,
	env: AppBindings,
	auth: { token: string; projectId: string },
): Promise<DeliveryResult> {
	const token = await decryptPushToken(installation.token_ciphertext, env);
	const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(auth.projectId)}/messages:send`, {
		method: "POST",
		headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
		body: json({
			message: {
				token,
				notification: { title: payload.title, body: payload.body },
				data: payload.data,
			},
		}),
	});
	if (response.ok) return { status: "sent" };
	const responseBody = await response.text();
	if (responseBody.includes("UNREGISTERED") || responseBody.includes("INVALID_ARGUMENT")) {
		return { status: "invalid", reason: `FCM_${response.status}` };
	}
	return { status: response.status >= 500 || response.status === 429 ? "retry" : "invalid", reason: `FCM_${response.status}` };
}

export async function sendNotificationDelivery(
	delivery: NotificationDeliveryRow,
	installation: PushInstallationRow,
	env: AppBindings,
	providers: { apnsToken?: string; fcmAuth?: { token: string; projectId: string } } = {},
): Promise<{ result: DeliveryResult; providers: { apnsToken?: string; fcmAuth?: { token: string; projectId: string } } }> {
	const payload: NotificationPayload = { title: delivery.title, body: delivery.body, data: JSON.parse(delivery.data_json) as Record<string, string> };
	try {
		if (installation.provider === "apns") {
			if (!providers.apnsToken) providers.apnsToken = await apnsProviderToken(env);
			return { result: await sendApns(installation, payload, env, providers.apnsToken), providers };
		}
		if (!providers.fcmAuth) providers.fcmAuth = await fcmAccessToken(env);
		return { result: await sendFcm(installation, payload, env, providers.fcmAuth), providers };
	} catch (error) {
		const message = error instanceof Error ? error.message : "PUSH_DELIVERY_FAILED";
		return {
			result: message.includes("not configured") ? { status: "skipped", reason: message } : { status: "retry", reason: message },
			providers,
		};
	}
}

export async function processNotificationDeliveries(db: D1Database, env: AppBindings, limit = 50): Promise<number> {
	const rows = (
		await db
			.prepare(
				`SELECT d.*, p.id AS p_id, p.game_id AS p_game_id, p.player_id AS p_player_id,
					p.installation_id AS p_installation_id, p.platform AS p_platform, p.provider AS p_provider,
					p.provider_environment AS p_provider_environment, p.token_ciphertext AS p_token_ciphertext,
					p.token_hash AS p_token_hash, p.notifications_enabled AS p_notifications_enabled,
					p.rank_updates_enabled AS p_rank_updates_enabled, p.admin_messages_enabled AS p_admin_messages_enabled,
					p.created_at AS p_created_at, p.updated_at AS p_updated_at, p.last_seen_at AS p_last_seen_at,
					p.invalidated_at AS p_invalidated_at
				 FROM notification_deliveries d JOIN push_installations p ON p.id = d.installation_id
				 WHERE d.status IN ('pending', 'failed') AND d.available_at <= ?
					AND d.attempts < 5 AND p.invalidated_at IS NULL AND p.notifications_enabled = 1
				 ORDER BY d.created_at ASC LIMIT ?`,
			)
			.bind(Math.floor(Date.now() / 1000), Math.max(1, Math.min(100, Math.floor(limit))))
			.all<NotificationDeliveryRow & Record<string, unknown>>()
	).results;
	let processed = 0;
	const providers: { apnsToken?: string; fcmAuth?: { token: string; projectId: string } } = {};
	for (const row of rows) {
		const claimed = await db
			.prepare(
				`UPDATE notification_deliveries
				 SET status = 'sending', attempts = attempts + 1
				 WHERE delivery_id = ? AND status IN ('pending', 'failed')`,
			)
			.bind(row.delivery_id)
			.run();
		if (claimed.meta.changes !== 1) continue;
		const installation: PushInstallationRow = {
			id: String(row.p_id), game_id: String(row.p_game_id), player_id: String(row.p_player_id), installation_id: String(row.p_installation_id),
			platform: row.p_platform as PushInstallationRow["platform"], provider: row.p_provider as PushInstallationRow["provider"],
			provider_environment: row.p_provider_environment as PushInstallationRow["provider_environment"], token_ciphertext: String(row.p_token_ciphertext), token_hash: String(row.p_token_hash),
			notifications_enabled: Number(row.p_notifications_enabled), rank_updates_enabled: Number(row.p_rank_updates_enabled), admin_messages_enabled: Number(row.p_admin_messages_enabled),
			created_at: Number(row.p_created_at), updated_at: Number(row.p_updated_at), last_seen_at: Number(row.p_last_seen_at), invalidated_at: row.p_invalidated_at === null ? null : Number(row.p_invalidated_at),
		};
		const delivery = row as unknown as NotificationDeliveryRow;
		const { result, providers: updatedProviders } = await sendNotificationDelivery(delivery, installation, env, providers);
		Object.assign(providers, updatedProviders);
		if (result.status === "sent") {
			await db.prepare("UPDATE notification_deliveries SET status = 'sent', sent_at = ?, last_error = NULL WHERE delivery_id = ?").bind(Math.floor(Date.now() / 1000), row.delivery_id).run();
		} else if (result.status === "skipped") {
			await db.prepare("UPDATE notification_deliveries SET status = 'skipped', last_error = ? WHERE delivery_id = ?").bind(result.reason, row.delivery_id).run();
		} else if (result.status === "invalid") {
			await db.batch([
				db.prepare("UPDATE push_installations SET invalidated_at = ?, notifications_enabled = 0, updated_at = ? WHERE id = ?").bind(Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), installation.id),
				db.prepare("UPDATE notification_deliveries SET status = 'failed', last_error = ? WHERE delivery_id = ?").bind(result.reason, row.delivery_id),
			]);
		} else {
			const attempts = Number(row.attempts) + 1;
			const status = attempts >= 5 ? "failed" : "failed";
			const retryAt = Math.floor(Date.now() / 1000) + Math.min(3600, 30 * 2 ** Math.min(attempts, 6));
			await db.prepare("UPDATE notification_deliveries SET status = ?, available_at = ?, last_error = ? WHERE delivery_id = ?").bind(status, retryAt, result.reason, row.delivery_id).run();
		}
		processed += 1;
	}
	return processed;
}

export async function processNotifications(db: D1Database, env: AppBindings): Promise<{ events: number; deliveries: number }> {
	const events = await processNotificationEvents(db);
	const deliveries = await processNotificationDeliveries(db, env);
	return { events, deliveries };
}
