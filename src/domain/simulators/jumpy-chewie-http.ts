import type {
	ReplayValidationContext,
	ReplayValidationInput,
	ReplayValidationResult,
	ReplayStats,
	ReplayValidator,
} from "../replay-validator";
import {
	normalizeReplayInputTrace,
	replayTimelineDurationMs,
	translatePlatformInputTrace,
} from "./jumpy-chewie-translation";

const CONTRACT_VERSION = 1;
const TIMESTEP_MS = 8;
const MAX_DURATION_MS = 300_000;

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Calls the exact-build simulator maintained with Jumpy Chewie when its URL is
 * configured. Without that feature flag, the platform uses trusted mode.
 */
export class JumpyChewieHttpValidator implements ReplayValidator {
	async validate(input: ReplayValidationInput, context?: ReplayValidationContext): Promise<ReplayValidationResult> {
		const url = context?.env?.JUMPY_CHEWIE_SIMULATOR_URL?.trim();
		if (!url) {
			return {
				status: "accepted",
				reason: "TRUSTED_SUBMISSION",
				stats: {
					score: input.run.score,
					game_stats: input.run.game_stats,
				},
			};
		}

		const timelineDurationMs = replayTimelineDurationMs(input.run);
		if (timelineDurationMs <= 0 || timelineDurationMs > MAX_DURATION_MS || timelineDurationMs % TIMESTEP_MS !== 0) {
			return { status: "rejected", reason: "INVALID_REPLAY_DURATION" };
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10_000);
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(context?.env?.JUMPY_CHEWIE_SIMULATOR_TOKEN
						? { authorization: `Bearer ${context.env.JUMPY_CHEWIE_SIMULATOR_TOKEN}` }
						: {}),
				},
				body: JSON.stringify({
					contract_version: CONTRACT_VERSION,
					game_id: "jumpy-chewie",
					ruleset_version: input.rulesetVersion,
					game_build_version: input.gameBuildVersion,
					run_seed: input.runSeed,
					run_mode: input.run.run_mode,
					simulation_timestep_ms: TIMESTEP_MS,
					run_duration_ms: timelineDurationMs,
					input_trace: translatePlatformInputTrace(normalizeReplayInputTrace(input.inputTrace)),
				}),
				signal: controller.signal,
			});
			if (!response.ok) return { status: "pending", reason: `SIMULATOR_HTTP_${response.status}` };

			const payload: unknown = await response.json();
			if (
				!isRecord(payload) ||
				payload.ok !== true ||
				!isRecord(payload.game_stats) ||
				typeof payload.canonical_game_stats !== "string"
			) {
				return { status: "pending", reason: "INVALID_SIMULATOR_RESPONSE" };
			}
			const stats = payload.game_stats as ReplayStats["game_stats"];
			if (!Number.isInteger(stats.score)) {
				return { status: "pending", reason: "INVALID_SIMULATOR_STATS" };
			}
			try {
				if (stableJson(JSON.parse(payload.canonical_game_stats)) !== stableJson(stats)) {
					return { status: "rejected", reason: "SIMULATOR_CANONICAL_STATS_MISMATCH" };
				}
			} catch {
				return { status: "rejected", reason: "SIMULATOR_CANONICAL_STATS_INVALID" };
			}
			return {
				status: "accepted",
				reason: "AUTHORITATIVE_REPLAY_MATCH",
				stats: { score: Number(stats.score), game_stats: stats },
			};
		} catch {
			return { status: "pending", reason: "SIMULATOR_UNAVAILABLE" };
		} finally {
			clearTimeout(timeout);
		}
	}
}
