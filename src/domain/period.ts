export type LeaderboardPeriod = "today" | "this_week" | "all_time";

const DAY_SECONDS = 86_400;

export function getPeriodBounds(period: LeaderboardPeriod, serverNow: number) {
	if (period === "all_time") return { start: 0, nextReset: 0 };

	const dayStart = serverNow - (serverNow % DAY_SECONDS);
	if (period === "today") return { start: dayStart, nextReset: dayStart + DAY_SECONDS };

	const dayOfWeek = new Date(serverNow * 1000).getUTCDay();
	const daysSinceMonday = (dayOfWeek + 6) % 7;
	const mondayStart = dayStart - daysSinceMonday * DAY_SECONDS;
	return { start: mondayStart, nextReset: mondayStart + 7 * DAY_SECONDS };
}

export function isLeaderboardPeriod(value: string): value is LeaderboardPeriod {
	return value === "today" || value === "this_week" || value === "all_time";
}
