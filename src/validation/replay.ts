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

const genericEventSchema = z
	.object({
		type: z.string().min(1).max(64),
		t_ms: timestampSchema,
		data: z.record(z.string().max(64), z.unknown()).default({}),
	})
	.strict();

export const replayInputEventSchema = z.union([
	swipeEventSchema,
	pickupEventSchema,
	pauseEventSchema,
	resumeEventSchema,
	genericEventSchema,
]);

export const replayInputTraceSchema = z
	.array(replayInputEventSchema)
	.max(10_000)
	.superRefine((events, context) => {
		let previousTimestamp = -1;
		for (const [index, event] of events.entries()) {
			if (event.t_ms < previousTimestamp) {
				context.addIssue({
					code: "custom",
					path: [index, "t_ms"],
					message: "Input trace timestamps must be monotonic",
				});
			}
			previousTimestamp = event.t_ms;
		}
	});

export type ReplayInputEvent = z.infer<typeof replayInputEventSchema>;
export type ReplayInputTrace = z.infer<typeof replayInputTraceSchema>;
