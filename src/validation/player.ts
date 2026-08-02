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

export const playerRegistrationSchema = z
	.object({
		player_id: z.string().min(1).max(128),
		display_name: displayNameSchema,
	})
	.strict();

export type PlayerRegistration = z.infer<typeof playerRegistrationSchema>;
