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

The first API routes are:

- `POST /v1/games/:slug/players` with `{ "player_id": "...", "display_name": "..." }` to register or restore a player.
- `PATCH /v1/games/:slug/players/:playerId` with `{ "display_name": "..." }` to update a player name.
- `POST /v1/games/:slug/run-sessions` with `player_id`, `ruleset_version`, and `game_build_version` to receive a one-time server-issued run session.
- `POST /v1/games/:slug/runs` with the validated run payload plus the session's `session_token`, `session_nonce`, `run_id`, `run_seed`, and `input_trace`.
- `GET /v1/games/:slug/leaderboards/:period?ruleset_version=...` for `today`, `this_week`, or `all_time` rankings. Optional `player_id`, `top_limit`, and `nearby_limit` query parameters return the current player window.

Submissions now require a short-lived, one-time session bound to the game, player, ruleset, build, seed, and run ID. The session token is stored only as a SHA-256 hash. The input trace is bounded, uses monotonic millisecond timestamps, and currently supports swipe, pickup, pause, and resume events. Structurally valid submissions are stored as `pending` and are excluded from leaderboards until the authoritative replay simulator accepts them. This is deliberate: the platform will not treat client-reported final statistics as proof of a real score.

The next anti-cheat milestone is the authoritative simulator for each game/ruleset/build. It must replay the trace from the server-issued seed and compare the resulting score/statistics with the submitted values before changing `verification_status` to `accepted`. Session tokens and trace validation are evidence and replay resistance, not a substitute for that simulator.

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
- `rulesets`: versioned rules for a game, with an eligibility flag and a unique `(game_id, version)` key.
- `players`: stable player identity and timestamps.
- `game_players`: per-game display name and membership, keyed by `(game_id, player_id)`.
- `runs`: idempotent `run_id`, game/player/ruleset association, score and gameplay statistics, client/server timestamps, verification status, and JSON power-up statistics.
- `run_sessions`: short-lived server-issued run identity, seed, nonce, hashed token, expiry, and one-time consumption state.
- `request_limits`: per-scope subject counters used for submission and leaderboard refresh windows.

Runs have composite foreign keys to both `game_players` and `(game_id, ruleset_version)`. This prevents a run from mixing a player or ruleset from another game. Indexes cover ruleset eligibility, player lookup, server receipt order, and accepted-run score ordering.

The development seed creates the fictional `Cloud Hopper` game and its eligible `cloud-hopper-1` ruleset. The seed is idempotent and can be run again with `npm run db:seed`.

## PostgreSQL migration considerations

The schema deliberately uses application-supplied text IDs, UTC Unix-second timestamps, explicit JSON text for variable power-up statistics and input traces, and composite foreign keys. A future PostgreSQL migration should map these to `text` or UUID IDs, `timestamptz` timestamps, `jsonb` statistics/traces, and retain the composite uniqueness/foreign-key relationships. Keep `token_hash` indexed and unique; never migrate or store the plaintext session token. The `request_limits` table can remain a keyed window counter or move to a dedicated rate-limit service. PostgreSQL partial indexes and `CHECK` constraints can carry over directly. The current SQL avoids SQLite-specific query behavior in the application layer, but the migration itself will need PostgreSQL DDL equivalents for `unixepoch()` and SQLite JSON checks.

No remote Cloudflare database or deployment is required for this foundation.
