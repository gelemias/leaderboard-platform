export type AppBindings = Env & {
	PLATFORM_API_TOKEN?: string;
	AUTH_REQUIRED?: string;
	ENVIRONMENT?: string;
	SESSION_RATE_LIMIT_PER_HOUR?: string;
	SUBMISSION_RATE_LIMIT_PER_HOUR?: string;
	LEADERBOARD_RATE_LIMIT_PER_MINUTE?: string;
};

export type AppEnv = { Bindings: AppBindings };

export type GameRow = {
	id: string;
	slug: string;
	name: string;
	status: string;
};

export type RulesetRow = {
	id: string;
	game_id: string;
	version: string;
	eligible_for_leaderboard: number;
	validator_key: string;
};

export type GamePlayerRow = {
	game_id: string;
	player_id: string;
	display_name: string;
};

export type RunRow = {
	run_id: string;
	game_id: string;
	player_id: string;
	ruleset_version: string;
	score: number;
	jumps: number;
	near_misses: number;
	highest_combo: number;
	run_seed: number;
	run_duration: number;
	game_build_version: string;
	run_mode: string;
	client_completed_at: number;
	server_received_at: number;
	verification_status: string;
	power_up_types_collected: string;
	power_up_collection_counts: string;
	power_up_activation_counts: string;
	shield_breaks: number;
	double_gum_boosted_jumps: number;
	jump_score_points: number;
	double_gum_bonus_points: number;
	golden_treat_bonus_points: number;
	run_session_id: string | null;
	input_trace: string;
	game_stats: string;
};

export type RunSessionRow = {
	run_id: string;
	game_id: string;
	player_id: string;
	ruleset_version: string;
	game_build_version: string;
	run_seed: number;
	token_hash: string;
	nonce: string;
	issued_at: number;
	expires_at: number;
	consumed_at: number | null;
	status: "issued" | "submitted" | "expired" | "rejected";
};
