export type AppBindings = Env & {
	PLATFORM_API_TOKEN?: string;
	JUMPY_CHEWIE_SIMULATOR_URL?: string;
	JUMPY_CHEWIE_SIMULATOR_TOKEN?: string;
	AUTH_REQUIRED?: string;
	ENVIRONMENT?: string;
	SESSION_RATE_LIMIT_PER_HOUR?: string;
	SUBMISSION_RATE_LIMIT_PER_HOUR?: string;
	LEADERBOARD_RATE_LIMIT_PER_MINUTE?: string;
	MOBILE_ACCESS_TOKEN_TTL_SECONDS?: string;
	PUSH_TOKEN_ENCRYPTION_KEY?: string;
	APNS_TEAM_ID?: string;
	APNS_KEY_ID?: string;
	APNS_BUNDLE_ID?: string;
	APNS_PRIVATE_KEY?: string;
	FCM_SERVICE_ACCOUNT_JSON?: string;
	FCM_PROJECT_ID?: string;
};

export type AppEnv = {
	Bindings: AppBindings;
	Variables: {
		mobileAccessToken?: MobileAccessTokenRow;
		allowImplicitRunPlayer?: boolean;
		allowOfflineRun?: boolean;
	};
};

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

export type MobileAccessTokenRow = {
	token_id: string;
	game_id: string;
	player_id: string;
	token_hash: string;
	issued_at: number;
	expires_at: number;
	revoked_at: number | null;
};

export type PushInstallationRow = {
	id: string;
	game_id: string;
	player_id: string;
	installation_id: string;
	platform: "ios" | "android";
	provider: "apns" | "fcm";
	provider_environment: "sandbox" | "production";
	token_ciphertext: string;
	token_hash: string;
	notifications_enabled: number;
	rank_updates_enabled: number;
	admin_messages_enabled: number;
	created_at: number;
	updated_at: number;
	last_seen_at: number;
	invalidated_at: number | null;
};

export type LeaderboardPositionRow = {
	game_id: string;
	ruleset_version: string;
	period: "today" | "this_week" | "all_time";
	period_start: number;
	player_id: string;
	rank: number;
	score: number;
};

export type NotificationDeliveryRow = {
	delivery_id: string;
	installation_id: string;
	game_id: string;
	player_id: string;
	kind: "rank_lost" | "admin_message";
	campaign_id: string | null;
	dedupe_key: string;
	title: string;
	body: string;
	data_json: string;
	status: "pending" | "sending" | "sent" | "failed" | "skipped";
	attempts: number;
	available_at: number;
	last_error: string | null;
	created_at: number;
	sent_at: number | null;
};
