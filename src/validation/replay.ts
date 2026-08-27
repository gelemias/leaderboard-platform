import { z } from "zod";

export const replayDirectionSchema = z.enum(["left", "right", "up", "down"]);

const timestampSchema = z.number().int().min(0).max(30 * 60 * 1000);

const swipeEventSchema = z
	.object({ type: z.literal("swipe"), t_ms: timestampSchema, direction: replayDirectionSchema })
	.strict();

const pickupEventSchema = z
	.object({
		type: z.literal("tap_pickup"),
		t_ms: timestampSchema,
		pickup_id: z.string().min(1).max(128),
	})
	.strict();

const pauseEventSchema = z.object({ type: z.literal("pause"), t_ms: timestampSchema }).strict();
const resumeEventSchema = z.object({ type: z.literal("resume"), t_ms: timestampSchema }).strict();
// The rewarded revive. Like pause and resume it carries nothing but its moment;
// what it means is decided by the simulation, which refuses one on a run that is
// not dead the way it refuses a swipe into a wall.
const reviveEventSchema = z.object({ type: z.literal("revive"), t_ms: timestampSchema }).strict();

const jumpySwipeEventSchema = z
	.object({ type: z.literal("swipe"), timestamp_ms: timestampSchema, direction: replayDirectionSchema })
	.strict();

const jumpyPickupEventSchema = z
	.object({
		type: z.literal("pickup_tap"),
		timestamp_ms: timestampSchema,
		pickup_id: z.number().int().positive(),
	})
	.strict();

const jumpyPauseEventSchema = z.object({ type: z.literal("pause"), timestamp_ms: timestampSchema }).strict();
const jumpyResumeEventSchema = z.object({ type: z.literal("resume"), timestamp_ms: timestampSchema }).strict();
const jumpyReviveEventSchema = z.object({ type: z.literal("revive"), timestamp_ms: timestampSchema }).strict();

const genericEventSchema = z
	.object({
		type: z.string().min(1).max(64),
		t_ms: timestampSchema,
		data: z.record(z.string().max(64), z.unknown()).default({}),
	})
	.strict();

// The generic variant stays last: it matches any typed event, so anything with a
// shape of its own has to be offered first or it is swallowed and loses it.
export const platformReplayInputEventSchema = z.union([
	swipeEventSchema,
	pickupEventSchema,
	pauseEventSchema,
	resumeEventSchema,
	reviveEventSchema,
	genericEventSchema,
]);

export const jumpyReplayInputEventSchema = z.union([
	jumpySwipeEventSchema,
	jumpyPickupEventSchema,
	jumpyPauseEventSchema,
	jumpyResumeEventSchema,
	jumpyReviveEventSchema,
]);

export const replayInputEventSchema = z.union([
	platformReplayInputEventSchema,
	jumpyReplayInputEventSchema,
]);

function eventTimestamp(event: z.infer<typeof replayInputEventSchema>): number {
	return "t_ms" in event ? event.t_ms : event.timestamp_ms;
}

export const replayInputTraceSchema = z
	.array(replayInputEventSchema)
	.max(10_000)
	.superRefine((events, context) => {
		let previousTimestamp = -1;
		for (const [index, event] of events.entries()) {
			const timestamp = eventTimestamp(event);
			if (timestamp < previousTimestamp) {
				context.addIssue({
					code: "custom",
					path: [index, "t_ms" in event ? "t_ms" : "timestamp_ms"],
					message: "Input trace timestamps must be monotonic",
				});
			}
			previousTimestamp = timestamp;
		}
	});

export type ReplayInputEvent = z.infer<typeof replayInputEventSchema>;
export type ReplayInputTrace = z.infer<typeof replayInputTraceSchema>;
export type PlatformReplayInputEvent = z.infer<typeof platformReplayInputEventSchema>;
export type PlatformReplayInputTrace = PlatformReplayInputEvent[];
export type JumpyReplayInputEvent = z.infer<typeof jumpyReplayInputEventSchema>;
export type JumpyReplayInputTrace = JumpyReplayInputEvent[];
