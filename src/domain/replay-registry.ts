import { TrustedReplayValidator, type ReplayValidator } from "./replay-validator";

function key(gameId: string, rulesetVersion: string, gameBuildVersion: string): string {
	return `${gameId}\u0000${rulesetVersion}\u0000${gameBuildVersion}`;
}

export class ReplayValidatorRegistry {
	private readonly validators = new Map<string, ReplayValidator>();
	private readonly trusted = new TrustedReplayValidator();

	register(
		gameId: string,
		rulesetVersion: string,
		gameBuildVersion: string,
		validator: ReplayValidator,
	): void {
		this.validators.set(key(gameId, rulesetVersion, gameBuildVersion), validator);
	}

	get(gameId: string, rulesetVersion: string, gameBuildVersion: string): ReplayValidator {
		return this.validators.get(key(gameId, rulesetVersion, gameBuildVersion)) ?? this.trusted;
	}

	remove(gameId: string, rulesetVersion: string, gameBuildVersion: string): void {
		this.validators.delete(key(gameId, rulesetVersion, gameBuildVersion));
	}
}

export const replayValidatorRegistry = new ReplayValidatorRegistry();
