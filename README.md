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
- `POST /v1/games/:slug/runs` with the validated run payload and `ruleset_version` to accept an idempotent normal run.
- `GET /v1/games/:slug/leaderboards/:period?ruleset_version=...` for `today`, `this_week`, or `all_time` rankings. Optional `player_id`, `top_limit`, and `nearby_limit` query parameters return the current player window.

Submission currently performs consistency validation and records accepted normal runs. Submission and leaderboard refreshes have persistent D1-backed request windows. This is not an anti-cheat replay validator, and authentication is intentionally deferred until the client/server identity mechanism is chosen.

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
- `request_limits`: per-scope subject counters used for submission and leaderboard refresh windows.

Runs have composite foreign keys to both `game_players` and `(game_id, ruleset_version)`. This prevents a run from mixing a player or ruleset from another game. Indexes cover ruleset eligibility, player lookup, server receipt order, and accepted-run score ordering.

The development seed creates the fictional `Cloud Hopper` game and its eligible `cloud-hopper-1` ruleset. The seed is idempotent and can be run again with `npm run db:seed`.

## PostgreSQL migration considerations

The schema deliberately uses application-supplied text IDs, UTC Unix-second timestamps, explicit JSON text for variable power-up statistics, and composite foreign keys. A future PostgreSQL migration should map these to `text` or UUID IDs, `timestamptz` timestamps, `jsonb` statistics, and retain the composite uniqueness/foreign-key relationships. The `request_limits` table can remain a keyed window counter or move to a dedicated rate-limit service. PostgreSQL partial indexes and `CHECK` constraints can carry over directly. The current SQL avoids SQLite-specific query behavior in the application layer, but the migration itself will need PostgreSQL DDL equivalents for `unixepoch()` and SQLite JSON checks.

No remote Cloudflare database or deployment is required for this foundation.
