import type { RunSubmission } from "../validation/run";
import type { ReplayInputTrace } from "../validation/replay";

export type ReplayValidationInput = {
	run: RunSubmission;
	inputTrace: ReplayInputTrace;
	runSeed: number;
	rulesetVersion: string;
	gameBuildVersion: string;
};

export type ReplayValidationResult =
	| { status: "accepted"; reason: "AUTHORITATIVE_REPLAY_MATCH" }
	| { status: "rejected"; reason: string }
	| { status: "pending"; reason: "SIMULATOR_NOT_IMPLEMENTED" };

export interface ReplayValidator {
	validate(input: ReplayValidationInput): Promise<ReplayValidationResult>;
}

/**
 * Safe default until a game/ruleset/build-specific simulator is registered.
 * Keeping this explicit prevents a client-provided score from being promoted
 * to the leaderboard merely because the request passed schema validation.
 */
export class PendingReplayValidator implements ReplayValidator {
	async validate(_input: ReplayValidationInput): Promise<ReplayValidationResult> {
		return { status: "pending", reason: "SIMULATOR_NOT_IMPLEMENTED" };
	}
}
