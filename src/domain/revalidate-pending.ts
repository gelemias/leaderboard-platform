import { getPendingRuns } from "../db";
import type { AppBindings, RunRow } from "../types";
import type { RunSubmission } from "../validation/run";
import { replayStatsMatch } from "./replay-validator";
import { replayValidatorRegistry } from "./replay-registry";
import { acceptedRunEventStatement } from "./notifications";

export type RevalidationSummary = {
	processed: number;
	accepted: number;
	rejected: number;
	still_pending: number;
};

function parseJson<T>(value: string, fallback: T): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function submissionFromRow(row: RunRow): RunSubmission {
	return {
		run_id: row.run_id,
		game_id: row.game_id,
		player_id: row.player_id,
		name: "",
		ruleset_version: row.ruleset_version,
		score: row.score,
		jumps: row.jumps,
		near_misses: row.near_misses,
		highest_combo: row.highest_combo,
		run_seed: row.run_seed,
		run_duration: row.run_duration,
		game_build_version: row.game_build_version,
		run_mode: row.run_mode as RunSubmission["run_mode"],
		client_completed_at: row.client_completed_at,
		power_up_types_collected: parseJson(row.power_up_types_collected, []),
		power_up_collection_counts: parseJson(row.power_up_collection_counts, {}),
		power_up_activation_counts: parseJson(row.power_up_activation_counts, {}),
		shield_breaks: row.shield_breaks,
		double_gum_boosted_jumps: row.double_gum_boosted_jumps,
		jump_score_points: row.jump_score_points,
		double_gum_bonus_points: row.double_gum_bonus_points,
		golden_treat_bonus_points: row.golden_treat_bonus_points,
		session_token: "revalidation",
		session_nonce: "00000000-0000-0000-0000-000000000000",
		input_trace: parseJson(row.input_trace, []),
		game_stats: parseJson(row.game_stats, {}),
	};
}

export async function revalidatePendingRuns(
	db: D1Database,
	env: AppBindings,
	limit = 25,
): Promise<RevalidationSummary> {
	const rows = await getPendingRuns(db, Math.max(1, Math.min(100, Math.floor(limit))));
	const summary: RevalidationSummary = { processed: 0, accepted: 0, rejected: 0, still_pending: 0 };

	for (const row of rows) {
		const run = submissionFromRow(row);
		const result = await replayValidatorRegistry
			.get(row.game_id, row.ruleset_version, row.game_build_version)
			.validate(
				{
					run,
					inputTrace: run.input_trace,
					runSeed: row.run_seed,
					rulesetVersion: row.ruleset_version,
					gameBuildVersion: row.game_build_version,
				},
				{ env },
			);
		const status =
			result.status === "accepted" && replayStatsMatch(run, result.stats)
				? "accepted"
				: result.status === "rejected" || result.status === "accepted"
					? "rejected"
					: "pending";

		summary.processed += 1;
		if (status === "pending") {
			summary.still_pending += 1;
			continue;
		}
		const statements = [
			db.prepare("UPDATE runs SET verification_status = ? WHERE run_id = ? AND verification_status = 'pending'").bind(status, row.run_id),
		];
		if (status === "accepted") {
			statements.push(acceptedRunEventStatement(db, {
				run_id: row.run_id,
				game_id: row.game_id,
				ruleset_version: row.ruleset_version,
			}));
		}
		const [updated] = await db.batch(statements);
		if (updated.meta.changes === 1) summary[status] += 1;
	}

	return summary;
}
