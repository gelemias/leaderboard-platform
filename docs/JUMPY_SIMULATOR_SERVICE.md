# Jumpy Chewie simulator service

The leaderboard Worker cannot execute Godot inside a Cloudflare Worker. It can
optionally delegate replay execution to the exact-build simulator service
configured by `JUMPY_CHEWIE_SIMULATOR_URL`. Without that URL, the generic
leaderboard uses trusted session-bound submissions instead.

The Worker sends a `POST` request with the Jumpy replay contract:

```json
{
  "contract_version": 1,
  "game_id": "jumpy-chewie",
  "ruleset_version": "jumpy-chewie-2",
  "game_build_version": "0.1.0",
  "run_seed": 1,
  "run_mode": "normal",
  "simulation_timestep_ms": 8,
  "run_duration_ms": 1000,
  "input_trace": [{"type": "swipe", "timestamp_ms": 0, "direction": "up"}]
}
```

The service must run the committed Godot deterministic replay runner and return:

```json
{
  "ok": true,
  "termination": "duration",
  "game_stats": {"score": 1, "jumps": 1},
  "canonical_game_stats": "{...}"
}
```

In the real response, `game_stats` must be the complete canonical object from `ReplayContract.game_stats_from_state`, and `canonical_game_stats` must be its JSON serialization. The Worker compares the returned score and complete stats object against the submitted run. It does not trust a simulator response that is malformed or whose canonical serialization disagrees with its object.

The service should return a non-2xx response while unavailable. When the URL is
configured, the Worker keeps those runs pending so Cron can retry them; it does
not fall back to trusted mode during an outage. The optional
`JUMPY_CHEWIE_SIMULATOR_TOKEN` is sent as a bearer token.
