import type { AppBindings } from "./types";

export type RateLimits = {
	sessionsPerHour: number;
	submissionsPerHour: number;
	leaderboardPerMinute: number;
};

function boundedInteger(value: string | undefined, fallback: number, maximum: number): number {
	if (!value) return fallback;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

export function getRateLimits(env: AppBindings): RateLimits {
	return {
		sessionsPerHour: boundedInteger(env.SESSION_RATE_LIMIT_PER_HOUR, 20, 1000),
		submissionsPerHour: boundedInteger(env.SUBMISSION_RATE_LIMIT_PER_HOUR, 30, 1000),
		leaderboardPerMinute: boundedInteger(env.LEADERBOARD_RATE_LIMIT_PER_MINUTE, 60, 1000),
	};
}
