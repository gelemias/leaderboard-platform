import { z } from "zod";

const reservedNames = new Set(["ADMIN", "SYSTEM", "MODERATOR"]);

export const displayNameSchema = z
	.string()
	.transform((value) => value.trim().replace(/\s+/g, " "))
	.pipe(
		z
			.string()
			.min(3)
			.max(16)
			.refine((value) => !/[\p{C}]/u.test(value), "Name contains invisible or control characters")
			.refine((value) => !reservedNames.has(value.toUpperCase()), "Name is reserved"),
	);

const playerNameFields = {
	display_name: displayNameSchema.optional(),
	name: displayNameSchema.optional(),
};

function requireExactlyOnePlayerName(
	value: { display_name?: string; name?: string },
	context: z.RefinementCtx,
): void {
	if (value.display_name === undefined && value.name === undefined) {
		context.addIssue({
			code: "custom",
			path: ["name"],
			message: "Either name or display_name is required",
		});
	}
	if (value.display_name !== undefined && value.name !== undefined) {
		context.addIssue({
			code: "custom",
			path: ["name"],
			message: "Use either name or display_name, not both",
		});
	}
}

export const playerRegistrationSchema = z
	.object({
		player_id: z.string().min(1).max(128),
		...playerNameFields,
	})
	.strict()
	.superRefine(requireExactlyOnePlayerName)
	.transform(({ player_id, display_name, name }) => ({
		player_id,
		display_name: display_name ?? name!,
	}));

export type PlayerRegistration = z.infer<typeof playerRegistrationSchema>;

export const playerNameUpdateSchema = z
	.object(playerNameFields)
	.strict()
	.superRefine(requireExactlyOnePlayerName)
	.transform(({ display_name, name }) => ({ display_name: display_name ?? name! }));
