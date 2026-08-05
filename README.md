# Leaderboard Platform

This is an independent Cloudflare Workers leaderboard foundation with a local D1-backed schema, health endpoint, player registration, validated run submission, and leaderboard reads.

## Setup and local development

```bash
npm install
npm run cf-typegen
npm run db:migrate
npm run db:seed
npm run dev
```

The Worker is available at `http://localhost:8787/health`.

Validate the deploy bundle without uploading it:

```bash
npm run deploy:check
```

The production deployment uses the separately configured remote D1 database. Apply its migrations before the first deployment:

```bash
npm run db:migrate:remote
npm run db:seed:remote
npx wrangler secret put PLATFORM_API_TOKEN --env production
npm run deploy
```

The first API routes are:

- `POST /v1/games/:slug/players` with `{ "player_id": "...", "name": "..." }` to register or restore a player. `display_name` is accepted as the platform-native alias.
- `PATCH /v1/games/:slug/players/:playerId` with `{ "name": "..." }` to update a player name. `display_name` is accepted as the platform-native alias.
- `DELETE /v1/games/:slug/players/:playerId` to remove a player from the game and its leaderboards. This also deletes that game-scoped player's runs, run sessions, and mobile access tokens; the shared player identity remains available for other games.
- `DELETE /v1/mobile/games/:slug/players/:playerId` with the player's mobile access token to perform the same removal without sending the platform bearer token from the app. The mobile token must belong to both the requested game and player.
- `POST /v1/games/:slug/run-sessions` with `player_id`, `ruleset_version`, and `game_build_version` to receive a one-time server-issued run session. Game adapters may also send `run_mode` and `simulation_timestep_ms` as simulator contract metadata.
- `POST /v1/mobile/games/:slug/access-tokens` with an optional `{ "player_id": "...", "display_name": "..." }` body as the app-facing broker endpoint. It accepts no `Authorization` header; the Worker uses its server-side `PLATFORM_API_TOKEN` configuration and returns a short-lived, game/player-scoped mobile access token plus the provisioned `player_id`, `name`, `expires_at`, and `expires_in`. If `player_id` is omitted, the broker provisions an anonymous player. Never ship `PLATFORM_API_TOKEN` in the mobile app.
- `POST /v1/mobile/games/:slug/run-sessions` with the mobile access token as `Authorization: Bearer ...` to receive a run session without the platform bearer token. `player_id` is optional for this mobile route and defaults to the player associated with the access token.
- `POST /v1/mobile/games/:slug/runs` with the run payload plus the issued `session_token` and `session_nonce`. `player_id` is optional for this mobile route and is derived from the one-time session. This route is intentionally bearerless; the one-time session is the submission credential.
- `POST /v1/games/:slug/runs` with the validated run payload plus the session's `session_token`, `session_nonce`, `run_id`, `run_seed`, and `input_trace`.
- `GET /v1/games/:slug/leaderboards/:period?ruleset_version=...` for `today`, `this_week`, or `all_time` rankings. Platform bearer tokens and game-scoped mobile access tokens are accepted; mobile requests may use only their token's `player_id` for the optional player window. The equivalent `/v1/mobile/games/:slug/leaderboards/:period` path is also supported.
- `GET /v1/public/games` returns the active game catalog and leaderboard-eligible rulesets without exposing platform credentials.
- `GET /v1/public/games/:slug/leaderboards/:period?ruleset_version=...` returns a public, read-only leaderboard feed for the dashboard.
- `PUT /v1/mobile/games/:slug/push-installations/:installationId` registers or rotates an iOS APNs or Android FCM token for the mobile-token player. `PATCH` updates preferences and `DELETE` removes the installation.
- `GET /v1/admin/games/:slug/players?search=...` returns a bounded, searchable player directory with push-eligibility counts for the admin message composer.
- `GET /v1/admin/session` is the no-store bearer-token check used to unlock the admin web surface.
- `GET /v1/admin/games` returns the active games used by the admin web selector.
- `DELETE /v1/admin/games/:slug/players/:playerId` permanently removes that player's game-scoped leaderboard data, runs, mobile access tokens, and push installations. The shared player identity remains available to other games.
- `POST /v1/admin/games/:slug/notifications/campaigns` queues an admin message for all opted-in installations or an explicit `player_ids` audience. The platform bearer protects this endpoint; put the admin surface behind Cloudflare Access in production.
- `GET /v1/admin/notifications/campaigns/:campaignId` returns campaign delivery counts.

The same Worker deployment also serves the static dashboard at `/`. It discovers games and rulesets through the public catalog API, so adding another active game does not require frontend code changes.

Submissions require a short-lived, one-time session bound to the game, player, ruleset, build, seed, and run ID. The session token is stored only as a SHA-256 hash. The input trace is bounded, uses monotonic millisecond timestamps, and currently supports swipe, pickup, pause, and resume events. `game_stats` is the canonical game-specific statistics object; the older Jumpy-shaped columns remain as compatibility fields during migration. By default, structurally valid session-bound submissions are accepted as `TRUSTED_SUBMISSION` and can appear on leaderboards. This protects the API from casual forgery and replay, but does not claim that the game result was independently recomputed.

The Worker supports an optional ruleset/build-specific simulator registry. When a registered simulator is configured, the Worker compares every score statistic before changing `verification_status` to `accepted`; unavailable or mismatching simulator results remain pending or rejected. When it is not configured, the platform uses the generic trusted path. Jumpy Chewie is registered against its exact-build simulator service, described in [the simulator service contract](docs/JUMPY_SIMULATOR_SERVICE.md).

The local `Cloud Hopper` seed includes the first registered reference adapter at build `reference-1`. It treats each generic `action` event as one authoritative point and rejects unsupported event types, so it is useful for exercising the complete acceptance path without pretending to be a production game simulator.

The Worker also translates Jumpy Chewie's native replay evidence at the boundary: `timestamp_ms` becomes `t_ms`, `pickup_tap` becomes `tap_pickup`, numeric pickup IDs become strings, and paused replay timelines are reconstructed from active duration plus paused duration. This is transport normalization only; when simulator validation is disabled, score acceptance uses the trusted session-bound path.

Jumpy Chewie simulator verification is an opt-in feature flag. If `JUMPY_CHEWIE_SIMULATOR_URL` is absent, Jumpy submissions use trusted mode. If it is set, the Worker sends the replay contract (seed, build, duration, and input trace) and requires a complete canonical `game_stats` object whose score and statistics exactly match the submission. The optional bearer secret is sent only when configured:

```bash
npx wrangler secret put JUMPY_CHEWIE_SIMULATOR_URL --env production
npx wrangler secret put JUMPY_CHEWIE_SIMULATOR_TOKEN --env production
```

Runs left pending while simulator validation is enabled are retried by the five-minute Worker Cron Trigger. An authenticated manual pass is also available at `POST /v1/replay-validation/revalidate?limit=25` using the platform bearer token. Removing the simulator URL switches that game/build back to trusted mode; pending runs are then promoted by the next revalidation pass.

## Production security configuration

The `/health` endpoint is public. Platform routes under `/v1/*` accept a platform bearer token when `PLATFORM_API_TOKEN` is configured. The mobile broker, session, and submission routes are the explicit exceptions: the broker accepts no app-supplied Authorization header and requires the Worker-side `PLATFORM_API_TOKEN` to be configured in production, session issuance requires the broker-issued mobile access token, and submissions require the issued `session_token` plus `session_nonce`. Set `AUTH_REQUIRED=true` or `ENVIRONMENT=production` in production; if authentication is required but the platform secret is missing, the Worker returns a configuration error instead of serving the platform API openly.

Configure secrets without committing them:

```bash
npx wrangler secret put PLATFORM_API_TOKEN
```

Configure these non-secret production variables in the Worker environment:

- `AUTH_REQUIRED=true` or `ENVIRONMENT=production`
- `SESSION_RATE_LIMIT_PER_HOUR` (default `20`)
- `SUBMISSION_RATE_LIMIT_PER_HOUR` (default `30`)
- `LEADERBOARD_RATE_LIMIT_PER_MINUTE` (default `60`)
- `MOBILE_ACCESS_TOKEN_TTL_SECONDS` (default `900`, capped at `3600`)

Push delivery also requires Worker secrets when enabled:

- `PUSH_TOKEN_ENCRYPTION_KEY`
- APNs: `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_BUNDLE_ID`, and `APNS_PRIVATE_KEY`
- FCM: `FCM_SERVICE_ACCOUNT_JSON` (and optionally `FCM_PROJECT_ID`)

The five-minute Cron Trigger revalidates pending runs, reconciles rank snapshots, and drains notification deliveries. Provider failures are retried with backoff; invalid APNs/FCM tokens are disabled automatically. In local development, missing provider credentials result in skipped deliveries rather than external calls.

The limits are persisted in D1 and capped by the Worker at safe configuration maxima. The local environment intentionally remains open when no token is configured so local tests and development do not require a secret.

Run the tests with:

```bash
npm test
```

Inspect the local schema and indexes with:

```bash
npm run db:inspect
npx wrangler d1 execute leaderboard-platform-dev --local --command="SELECT * FROM games;"
npx wrangler d1 execute leaderboard-platform-dev --local --command="SELECT * FROM rulesets;"
```

Wrangler persists local D1 data by default. The default binding uses the development database name `leaderboard-platform-dev`, a local preview ID, and a placeholder database ID. The `production` environment uses the remote database `leaderboard-platform-prod`. Keep `--local` on local migration or execute commands and use `--remote` only deliberately.

## Local schema

- `games`: game identity, slug, lifecycle status, and creation time.
- `rulesets`: versioned rules for a game, with an eligibility flag, validator profile, and a unique `(game_id, version)` key.
- `players`: stable player identity and timestamps.
- `game_players`: per-game display name and membership, keyed by `(game_id, player_id)`.
- `runs`: idempotent `run_id`, game/player/ruleset association, score, canonical `game_stats` JSON, compatibility statistics, client/server timestamps, verification status, and replay evidence.
- `run_sessions`: short-lived server-issued run identity, seed, nonce, hashed token, expiry, and one-time consumption state.
- `mobile_access_tokens`: short-lived game/player-scoped access tokens used to exchange trusted backend authorization for mobile run-session access. Only the SHA-256 hash is stored.
- `push_installations`: encrypted, game-scoped provider tokens and per-device opt-in preferences. A player can have multiple installations.
- `notification_events`: durable accepted-run outbox entries emitted for both immediate and delayed replay acceptance.
- `leaderboard_positions`: current rank snapshots for today, this week, and all time, used to detect rank losses without notifying on period resets.
- `notification_campaigns` and `notification_deliveries`: audited admin messages and idempotent provider delivery state.
- `request_limits`: per-scope subject counters used for submission and leaderboard refresh windows.

Runs have composite foreign keys to both `game_players` and `(game_id, ruleset_version)`. This prevents a run from mixing a player or ruleset from another game. Indexes cover ruleset eligibility/validator selection, player lookup, server receipt order, and accepted-run score ordering.

The development seed creates the fictional `Cloud Hopper` reference game and the `Jumpy Chewie` `jumpy-chewie-2` metadata. Cloud Hopper can accept its local reference replays; Jumpy Chewie remains `pending` until its exact simulator is ported and registered. The seed is idempotent and can be run again with `npm run db:seed`.

## PostgreSQL migration considerations

The schema deliberately uses application-supplied text IDs, UTC Unix-second timestamps, explicit JSON text for variable power-up statistics and input traces, and composite foreign keys. A future PostgreSQL migration should map these to `text` or UUID IDs, `timestamptz` timestamps, `jsonb` statistics/traces, and retain the composite uniqueness/foreign-key relationships. Keep `token_hash` indexed and unique; never migrate or store the plaintext session token. The `request_limits` table can remain a keyed window counter or move to a dedicated rate-limit service. PostgreSQL partial indexes and `CHECK` constraints can carry over directly. The current SQL avoids SQLite-specific query behavior in the application layer, but the migration itself will need PostgreSQL DDL equivalents for `unixepoch()` and SQLite JSON checks.

The remote production D1 database has been created, but it is not populated or deployed until the explicit remote migration, production metadata seed, and deployment commands above are run. The production seed contains only the Jumpy Chewie game/ruleset metadata; it contains no players or scores.

## Deployment readiness

Deployment is intentionally separate from local setup. The production environment contains the real D1 database ID, and `PLATFORM_API_TOKEN` must be configured as a Worker secret before deploying. Do not replace the development placeholder database ID in the default local configuration.
