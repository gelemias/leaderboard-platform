import { z } from "zod";
import { displayNameSchema } from "./player";
import { replayInputTraceSchema } from "./replay";

const nonNegativeInteger = z.number().int().nonnegative();
const powerUpCounts = z.record(z.string(), nonNegativeInteger);

export const runSubmissionSchema = z
	.object({
		run_id: z.string().min(1).max(128),
		game_id: z.string().min(1).max(128),
		player_id: z.string().min(1).max(128),
		name: displayNameSchema,
		ruleset_version: z.string().min(1).max(128),
		score: nonNegativeInteger,
		jumps: nonNegativeInteger,
		near_misses: nonNegativeInteger,
		highest_combo: z.number().int().min(1),
		run_seed: z.number().int(),
		run_duration: z.number().nonnegative().max(30 * 60),
		game_build_version: z.string().min(1).max(128),
		run_mode: z.enum(["normal", "tutorial", "practice", "debug", "assisted"]),
		client_completed_at: z.number().int().nonnegative(),
		power_up_types_collected: z.array(z.string().min(1).max(64)),
		power_up_collection_counts: powerUpCounts,
		power_up_activation_counts: powerUpCounts,
		shield_breaks: nonNegativeInteger,
		double_gum_boosted_jumps: nonNegativeInteger,
		jump_score_points: nonNegativeInteger,
		double_gum_bonus_points: nonNegativeInteger,
		golden_treat_bonus_points: nonNegativeInteger,
		session_token: z.string().min(32).max(128),
		session_nonce: z.string().uuid(),
		input_trace: replayInputTraceSchema,
	})
	.strict();

export type RunSubmission = z.infer<typeof runSubmissionSchema>;

export const runSubmissionRequestSchema = runSubmissionSchema.omit({ game_id: true });

export type RunSubmissionRequest = z.infer<typeof runSubmissionRequestSchema>;
