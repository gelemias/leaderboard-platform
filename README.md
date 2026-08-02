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

The first API routes are:

- `POST /v1/games/:slug/players` with `{ "player_id": "...", "display_name": "..." }` to register or restore a player.
- `PATCH /v1/games/:slug/players/:playerId` with `{ "display_name": "..." }` to update a player name.
- `POST /v1/games/:slug/run-sessions` with `player_id`, `ruleset_version`, and `game_build_version` to receive a one-time server-issued run session.
- `POST /v1/games/:slug/runs` with the validated run payload plus the session's `session_token`, `session_nonce`, `run_id`, `run_seed`, and `input_trace`.
- `GET /v1/games/:slug/leaderboards/:period?ruleset_version=...` for `today`, `this_week`, or `all_time` rankings. Optional `player_id`, `top_limit`, and `nearby_limit` query parameters return the current player window.

Submissions now require a short-lived, one-time session bound to the game, player, ruleset, build, seed, and run ID. The session token is stored only as a SHA-256 hash. The input trace is bounded, uses monotonic millisecond timestamps, and currently supports swipe, pickup, pause, and resume events. `game_stats` is the canonical game-specific statistics object; the older Jumpy-shaped columns remain as compatibility fields during migration. Structurally valid submissions are stored as `pending` and are excluded from leaderboards until the authoritative replay simulator accepts them. This is deliberate: the platform will not treat client-reported final statistics as proof of a real score.

The Worker now invokes a ruleset/build-specific simulator registry and compares every score statistic before changing `verification_status` to `accepted`. Unregistered combinations fail closed as `pending`; session tokens and trace validation are evidence and replay resistance, not a substitute for the simulator. The Jumpy Chewie adapter still needs to be ported from the Godot gameplay rules before that game can produce accepted remote scores.

The local `Cloud Hopper` seed includes the first registered reference adapter at build `reference-1`. It treats each generic `action` event as one authoritative point and rejects unsupported event types, so it is useful for exercising the complete acceptance path without pretending to be a production game simulator.

## Production security configuration

The `/health` endpoint is public. All `/v1/*` routes accept a platform bearer token when `PLATFORM_API_TOKEN` is configured. Set `AUTH_REQUIRED=true` or `ENVIRONMENT=production` in production; if authentication is required but the token is missing, the Worker returns a configuration error instead of serving the API openly.

Configure secrets without committing them:

```bash
npx wrangler secret put PLATFORM_API_TOKEN
```

Configure these non-secret production variables in the Worker environment:

- `AUTH_REQUIRED=true` or `ENVIRONMENT=production`
- `SESSION_RATE_LIMIT_PER_HOUR` (default `20`)
- `SUBMISSION_RATE_LIMIT_PER_HOUR` (default `30`)
- `LEADERBOARD_RATE_LIMIT_PER_MINUTE` (default `60`)

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

Wrangler persists local D1 data by default. The binding uses the development database name `leaderboard-platform-dev`, a local preview ID, and a placeholder database ID so no remote D1 database is created by this project. Keep `--local` on every local migration or execute command.

## Local schema

- `games`: game identity, slug, lifecycle status, and creation time.
- `rulesets`: versioned rules for a game, with an eligibility flag, validator profile, and a unique `(game_id, version)` key.
- `players`: stable player identity and timestamps.
- `game_players`: per-game display name and membership, keyed by `(game_id, player_id)`.
- `runs`: idempotent `run_id`, game/player/ruleset association, score, canonical `game_stats` JSON, compatibility statistics, client/server timestamps, verification status, and replay evidence.
- `run_sessions`: short-lived server-issued run identity, seed, nonce, hashed token, expiry, and one-time consumption state.
- `request_limits`: per-scope subject counters used for submission and leaderboard refresh windows.

Runs have composite foreign keys to both `game_players` and `(game_id, ruleset_version)`. This prevents a run from mixing a player or ruleset from another game. Indexes cover ruleset eligibility/validator selection, player lookup, server receipt order, and accepted-run score ordering.

The development seed creates the fictional `Cloud Hopper` game and its eligible `cloud-hopper-1` ruleset. The seed is idempotent and can be run again with `npm run db:seed`.

## PostgreSQL migration considerations

The schema deliberately uses application-supplied text IDs, UTC Unix-second timestamps, explicit JSON text for variable power-up statistics and input traces, and composite foreign keys. A future PostgreSQL migration should map these to `text` or UUID IDs, `timestamptz` timestamps, `jsonb` statistics/traces, and retain the composite uniqueness/foreign-key relationships. Keep `token_hash` indexed and unique; never migrate or store the plaintext session token. The `request_limits` table can remain a keyed window counter or move to a dedicated rate-limit service. PostgreSQL partial indexes and `CHECK` constraints can carry over directly. The current SQL avoids SQLite-specific query behavior in the application layer, but the migration itself will need PostgreSQL DDL equivalents for `unixepoch()` and SQLite JSON checks.

No remote Cloudflare database or deployment is required for this foundation.

## Deployment readiness

Deployment is intentionally not included in local setup. A real production D1 database ID must be placed in a production Wrangler environment, and `PLATFORM_API_TOKEN` must be configured as a Worker secret before deploying. Do not replace the development placeholder database ID in the default local configuration with a guessed value.
