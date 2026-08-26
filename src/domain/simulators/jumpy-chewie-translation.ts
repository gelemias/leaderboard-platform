import { z } from "zod";
import {
	jumpyReplayInputEventSchema,
	type JumpyReplayInputTrace,
	type PlatformReplayInputTrace,
	type ReplayInputEvent,
} from "../../validation/replay";
import type { RunSubmissionRequest } from "../../validation/run";

const JUMPY_GAME_ID = "jumpy-chewie";
const JUMPY_RULESET_VERSION = "jumpy-chewie-3";
const JUMPY_SUPPORTED_RULESET_VERSIONS = ["jumpy-chewie-2", JUMPY_RULESET_VERSION] as const;
const JUMPY_CONTRACT_VERSION = 1;
const JUMPY_TIMESTEP_MS = 8;
const JUMPY_MAX_DURATION_MS = 300_000;
const JUMPY_MAX_TRACE_EVENTS = 4_096;

const jumpyReplayContractSchema = z
	.object({
		contract_version: z.literal(JUMPY_CONTRACT_VERSION),
		game_id: z.literal(JUMPY_GAME_ID),
		ruleset_version: z.enum(JUMPY_SUPPORTED_RULESET_VERSIONS),
		game_build_version: z.string().min(1).max(128),
		run_seed: z.number().int().nonnegative(),
		run_mode: z.literal("normal"),
		simulation_timestep_ms: z.literal(JUMPY_TIMESTEP_MS),
		run_duration_ms: z.number().int().positive().max(JUMPY_MAX_DURATION_MS),
		input_trace: z.array(jumpyReplayInputEventSchema).max(JUMPY_MAX_TRACE_EVENTS),
	})
	.strict()
	.superRefine((request, context) => {
		if (request.run_duration_ms % JUMPY_TIMESTEP_MS !== 0) {
			context.addIssue({
				code: "custom",
				path: ["run_duration_ms"],
				message: "run_duration_ms must be aligned to the simulation timestep",
			});
		}

		let previousTimestamp = -1;
		let paused = false;
		for (const [index, event] of request.input_trace.entries()) {
			const timestamp = event.timestamp_ms;
			if (timestamp % JUMPY_TIMESTEP_MS !== 0 || timestamp >= request.run_duration_ms) {
				context.addIssue({
					code: "custom",
					path: ["input_trace", index, "timestamp_ms"],
					message: "event timestamp must be on the timestep grid and before run end",
				});
			}
			if (timestamp < previousTimestamp) {
				context.addIssue({
					code: "custom",
					path: ["input_trace", index, "timestamp_ms"],
					message: "input timestamps must be monotonic",
				});
			}
			previousTimestamp = timestamp;

			if (event.type === "pause") {
				if (paused) {
					context.addIssue({
						code: "custom",
						path: ["input_trace", index],
						message: "run cannot pause while already paused",
					});
				}
				paused = true;
			} else if (event.type === "resume") {
				if (!paused) {
					context.addIssue({
						code: "custom",
						path: ["input_trace", index],
						message: "run cannot resume while already running",
					});
				}
				paused = false;
			}
		}
	});

export type JumpyReplayContract = z.infer<typeof jumpyReplayContractSchema>;

export type TranslatedJumpyReplay = {
	contractVersion: number;
	gameId: string;
	rulesetVersion: string;
	gameBuildVersion: string;
	runSeed: number;
	runMode: "normal";
	simulationTimestepMs: number;
	replayDurationMs: number;
	inputTrace: PlatformReplayInputTrace;
};

export type NormalizedRunSubmissionRequest = Omit<RunSubmissionRequest, "input_trace"> & {
	input_trace: PlatformReplayInputTrace;
};

export function translateJumpyInputTrace(trace: JumpyReplayInputTrace): PlatformReplayInputTrace {
	return trace.map((event) => {
		switch (event.type) {
			case "swipe":
				return { type: "swipe", t_ms: event.timestamp_ms, direction: event.direction };
			case "pickup_tap":
				return { type: "tap_pickup", t_ms: event.timestamp_ms, pickup_id: String(event.pickup_id) };
			case "pause":
				return { type: "pause", t_ms: event.timestamp_ms };
			case "resume":
				return { type: "resume", t_ms: event.timestamp_ms };
		}
	});
}

export function translateJumpyReplayContract(raw: unknown):
	| { ok: true; replay: TranslatedJumpyReplay }
	| { ok: false; issues: z.ZodIssue[] } {
	const parsed = jumpyReplayContractSchema.safeParse(raw);
	if (!parsed.success) return { ok: false, issues: parsed.error.issues };

	return {
		ok: true,
		replay: {
			contractVersion: parsed.data.contract_version,
			gameId: parsed.data.game_id,
			rulesetVersion: parsed.data.ruleset_version,
			gameBuildVersion: parsed.data.game_build_version,
			runSeed: parsed.data.run_seed,
			runMode: parsed.data.run_mode,
			simulationTimestepMs: parsed.data.simulation_timestep_ms,
			replayDurationMs: parsed.data.run_duration_ms,
			inputTrace: translateJumpyInputTrace(parsed.data.input_trace),
		},
	};
}

export function normalizeReplayInputTrace(trace: ReplayInputEvent[]): PlatformReplayInputTrace {
	return trace.map((event) => {
		if ("timestamp_ms" in event) return translateJumpyInputTrace([event])[0];
		return event;
	});
}

export function translatePlatformInputTrace(trace: PlatformReplayInputTrace): JumpyReplayInputTrace {
	return trace.map((event) => {
		if (event.type === "swipe" && "direction" in event) {
			return { type: "swipe", timestamp_ms: event.t_ms, direction: event.direction };
		}
		if (event.type === "tap_pickup" && "pickup_id" in event) {
			const pickupId = Number(event.pickup_id);
			if (!Number.isInteger(pickupId) || pickupId <= 0) throw new Error("Invalid pickup id");
			return { type: "pickup_tap", timestamp_ms: event.t_ms, pickup_id: pickupId };
		}
		if (event.type === "pause") {
			return { type: "pause", timestamp_ms: event.t_ms };
		}
		if (event.type === "resume") {
			return { type: "resume", timestamp_ms: event.t_ms };
		}
		throw new Error(`Unsupported replay event: ${event.type}`);
	});
}

export function normalizeRunSubmission(request: RunSubmissionRequest): NormalizedRunSubmissionRequest {
	return { ...request, input_trace: normalizeReplayInputTrace(request.input_trace) };
}

export function replayActiveDurationMs(request: Pick<RunSubmissionRequest, "run_duration" | "game_stats">): number {
	const duration = request.game_stats.run_duration_ms;
	return typeof duration === "number" && Number.isInteger(duration) && duration > 0
		? duration
		: request.run_duration * 1000;
}

export function replayTimelineDurationMs(request: Pick<RunSubmissionRequest, "run_duration" | "game_stats">): number {
	const activeDuration = replayActiveDurationMs(request);
	const pausedDuration = request.game_stats.paused_duration_ms;
	return activeDuration +
		(typeof pausedDuration === "number" && Number.isInteger(pausedDuration) && pausedDuration > 0 ? pausedDuration : 0);
}

export { JUMPY_CONTRACT_VERSION, JUMPY_GAME_ID, JUMPY_RULESET_VERSION, JUMPY_TIMESTEP_MS };
