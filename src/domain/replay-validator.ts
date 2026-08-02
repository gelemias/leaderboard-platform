import type { RunSubmission } from "../validation/run";
import type { ReplayInputTrace } from "../validation/replay";
import type { AppBindings } from "../types";

export const REPLAY_STAT_KEYS = ["score", "game_stats"] as const;

export type ReplayStats = Pick<RunSubmission, (typeof REPLAY_STAT_KEYS)[number]>;

export type ReplayValidationInput = {
	run: RunSubmission;
	inputTrace: ReplayInputTrace;
	runSeed: number;
	rulesetVersion: string;
	gameBuildVersion: string;
};

export type ReplayValidationContext = {
	env?: AppBindings;
};

export type ReplayValidationResult =
	| { status: "accepted"; reason: "AUTHORITATIVE_REPLAY_MATCH" | "TRUSTED_SUBMISSION"; stats: ReplayStats }
	| { status: "rejected"; reason: string }
	| { status: "pending"; reason: string };

export interface ReplayValidator {
	validate(input: ReplayValidationInput, context?: ReplayValidationContext): Promise<ReplayValidationResult>;
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
 * Default mode for games that have not opted into authoritative replay.
 *
 * The run is still bound to a server-issued, one-time session and passes all
 * structural checks before it reaches this point. This mode prevents casual
 * request forgery and replay, but does not claim that the game result was
 * independently recomputed.
 */
export class TrustedReplayValidator implements ReplayValidator {
	async validate(input: ReplayValidationInput): Promise<ReplayValidationResult> {
		return {
			status: "accepted",
			reason: "TRUSTED_SUBMISSION",
			stats: {
				score: input.run.score,
				game_stats: input.run.game_stats,
			},
		};
	}
}

/**
 * Explicit fail-closed validator retained for callers that need pending
 * behavior rather than the platform's trusted default.
 */
export class PendingReplayValidator implements ReplayValidator {
	async validate(_input: ReplayValidationInput): Promise<ReplayValidationResult> {
		return { status: "pending", reason: "SIMULATOR_NOT_REGISTERED" };
	}
}
