import { Hono } from "hono";
import { getGameBySlug, getGamePlayer, getRuleset, getRunById } from "../db";
import { jsonError, readJson } from "../http";
import type { AppEnv } from "../types";
import { runSubmissionRequestSchema, type RunSubmissionRequest } from "../validation/run";
import { validateRunSubmission } from "../domain/run-validation";

export const runRoutes = new Hono<AppEnv>();

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function sameJson(stored: string, incoming: unknown): boolean {
	try {
		return stableJson(JSON.parse(stored)) === stableJson(incoming);
	} catch {
		return false;
	}
}

function sameRun(existing: Awaited<ReturnType<typeof getRunById>>, incoming: RunSubmissionRequest, gameId: string) {
	return (
		existing !== null &&
		existing.game_id === gameId &&
		existing.player_id === incoming.player_id &&
		existing.ruleset_version === incoming.ruleset_version &&
		existing.score === incoming.score &&
		existing.jumps === incoming.jumps &&
		existing.near_misses === incoming.near_misses &&
		existing.highest_combo === incoming.highest_combo &&
		existing.run_seed === incoming.run_seed &&
		existing.run_duration === incoming.run_duration &&
		existing.game_build_version === incoming.game_build_version &&
		existing.run_mode === incoming.run_mode &&
		existing.client_completed_at === incoming.client_completed_at &&
		sameJson(existing.power_up_types_collected, incoming.power_up_types_collected) &&
		sameJson(existing.power_up_collection_counts, incoming.power_up_collection_counts) &&
		sameJson(existing.power_up_activation_counts, incoming.power_up_activation_counts) &&
		existing.shield_breaks === incoming.shield_breaks &&
		existing.double_gum_boosted_jumps === incoming.double_gum_boosted_jumps &&
		existing.jump_score_points === incoming.jump_score_points &&
		existing.double_gum_bonus_points === incoming.double_gum_bonus_points &&
		existing.golden_treat_bonus_points === incoming.golden_treat_bonus_points
	);
}

runRoutes.post("/games/:slug/runs", async (c) => {
	const parsed = runSubmissionRequestSchema.safeParse(await readJson(c));
	if (!parsed.success) {
		return jsonError(c, 422, "INVALID_RUN", "Run submission is invalid", parsed.error.issues);
	}

	const game = await getGameBySlug(c.env.DB, c.req.param("slug"));
	if (!game || game.status !== "active") return jsonError(c, 404, "UNKNOWN_GAME", "Game was not found");

	const incoming = parsed.data;
	const ruleset = await getRuleset(c.env.DB, game.id, incoming.ruleset_version);
	if (!ruleset || ruleset.eligible_for_leaderboard !== 1) {
		return jsonError(c, 422, "INELIGIBLE_RULESET", "Ruleset is not eligible for this leaderboard");
	}

	const player = await getGamePlayer(c.env.DB, game.id, incoming.player_id);
	if (!player) return jsonError(c, 404, "UNKNOWN_PLAYER", "Player is not registered for this game");
	if (incoming.name !== player.display_name) {
		return jsonError(c, 422, "NAME_MISMATCH", "Run name does not match the registered player name");
	}

	const validationError = validateRunSubmission({ ...incoming, game_id: game.id });
	if (validationError) return jsonError(c, 422, "INVALID_RUN", validationError);

	const existing = await getRunById(c.env.DB, incoming.run_id);
	if (existing) {
		if (!sameRun(existing, incoming, game.id)) {
			return jsonError(c, 409, "RUN_ID_CONFLICT", "Run ID was already used for different data");
		}
		return c.json({
			ok: true,
			duplicate: true,
			run_id: existing.run_id,
			server_received_at: existing.server_received_at,
			verification_status: existing.verification_status,
		});
	}

	const serverReceivedAt = Math.floor(Date.now() / 1000);
	try {
		await c.env.DB.prepare(
			`INSERT INTO runs (
				run_id, game_id, player_id, ruleset_version, score, jumps, near_misses,
				highest_combo, run_seed, run_duration, game_build_version, run_mode,
				client_completed_at, server_received_at, verification_status,
				power_up_types_collected, power_up_collection_counts,
				power_up_activation_counts, shield_breaks, double_gum_boosted_jumps,
				jump_score_points, double_gum_bonus_points, golden_treat_bonus_points
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				incoming.run_id,
				game.id,
				incoming.player_id,
				incoming.ruleset_version,
				incoming.score,
				incoming.jumps,
				incoming.near_misses,
				incoming.highest_combo,
				incoming.run_seed,
				incoming.run_duration,
				incoming.game_build_version,
				incoming.run_mode,
				incoming.client_completed_at,
				serverReceivedAt,
				"accepted",
				stableJson(incoming.power_up_types_collected),
				stableJson(incoming.power_up_collection_counts),
				stableJson(incoming.power_up_activation_counts),
				incoming.shield_breaks,
				incoming.double_gum_boosted_jumps,
				incoming.jump_score_points,
				incoming.double_gum_bonus_points,
				incoming.golden_treat_bonus_points,
			)
			.run();
	} catch {
		const raced = await getRunById(c.env.DB, incoming.run_id);
		if (sameRun(raced, incoming, game.id)) {
			return c.json({
				ok: true,
				duplicate: true,
				run_id: raced?.run_id,
				server_received_at: raced?.server_received_at,
				verification_status: raced?.verification_status,
			});
		}
		return jsonError(c, 409, "RUN_ID_CONFLICT", "Run ID was already used for different data");
	}

	return c.json(
		{
			ok: true,
			duplicate: false,
			run_id: incoming.run_id,
			server_received_at: serverReceivedAt,
			verification_status: "accepted",
		},
		201,
	);
});
