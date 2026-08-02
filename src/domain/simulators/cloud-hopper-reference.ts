import type { ReplayValidator, ReplayValidationInput, ReplayValidationResult } from "../replay-validator";

/**
 * A deliberately small, fully specified development ruleset.
 *
 * Cloud Hopper is the fictional seed game, so this adapter is suitable for
 * local contract tests only. It proves the adapter boundary without claiming
 * to simulate Jumpy Chewie or any unported production game.
 */
export class CloudHopperReferenceValidator implements ReplayValidator {
	async validate(input: ReplayValidationInput): Promise<ReplayValidationResult> {
		const actions = input.inputTrace.filter((event) => event.type === "action");
		const unsupported = input.inputTrace.some((event) => event.type !== "action");
		if (unsupported) return { status: "rejected", reason: "UNSUPPORTED_REFERENCE_INPUT" };

		return {
			status: "accepted",
			reason: "AUTHORITATIVE_REPLAY_MATCH",
			stats: {
				score: actions.length,
				game_stats: { actions: actions.length },
			},
		};
	}
}
