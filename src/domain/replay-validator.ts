import type { RunSubmission } from "../validation/run";
import type { ReplayInputTrace } from "../validation/replay";

export const REPLAY_STAT_KEYS = [
	"score",
	"jumps",
	"near_misses",
	"highest_combo",
	"power_up_types_collected",
	"power_up_collection_counts",
	"power_up_activation_counts",
	"shield_breaks",
	"double_gum_boosted_jumps",
	"jump_score_points",
	"double_gum_bonus_points",
	"golden_treat_bonus_points",
] as const;

export type ReplayStats = Pick<RunSubmission, (typeof REPLAY_STAT_KEYS)[number]>;

export type ReplayValidationInput = {
	run: RunSubmission;
	inputTrace: ReplayInputTrace;
	runSeed: number;
	rulesetVersion: string;
	gameBuildVersion: string;
};

export type ReplayValidationResult =
	| { status: "accepted"; reason: "AUTHORITATIVE_REPLAY_MATCH"; stats: ReplayStats }
	| { status: "rejected"; reason: string }
	| { status: "pending"; reason: "SIMULATOR_NOT_REGISTERED" };

export interface ReplayValidator {
	validate(input: ReplayValidationInput): Promise<ReplayValidationResult>;
}

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

export function replayStatsMatch(submitted: ReplayStats, actual: ReplayStats): boolean {
	return REPLAY_STAT_KEYS.every((key) => stableJson(submitted[key]) === stableJson(actual[key]));
}

/**
 * Safe default until a game/ruleset/build-specific simulator is registered.
 * Schema validation alone must never promote a client-provided score.
 */
export class PendingReplayValidator implements ReplayValidator {
	async validate(_input: ReplayValidationInput): Promise<ReplayValidationResult> {
		return { status: "pending", reason: "SIMULATOR_NOT_REGISTERED" };
	}
}
