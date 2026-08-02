# Replay validation and trusted submission contract

The platform supports two verification modes. Every mode begins with the same
server-issued session boundary:

1. The client requests a short-lived server run session.
2. The Worker issues a run ID, nonce, seed, ruleset version, and build binding.
3. The client submits the final statistics and a timestamped input trace.

By default, the Worker stores structurally valid submissions as `accepted` with
`verification_code: TRUSTED_SUBMISSION`. This is generic across games and
provides session binding, replay resistance, rate limiting, and input validation,
but it does not independently recompute the game's score.

An optional simulator can be enabled for a specific game/ruleset/build. The
Worker then resolves that simulator, replays the trace, compares `score` and
the complete canonical `game_stats` object, and only accepts an exact match.
Unavailable simulator calls remain `pending`; rejected traces remain
`rejected`.

The local fictional `Cloud Hopper` seed has one reference adapter registered at
build `reference-1`. Its complete ruleset is intentionally simple: every
generic `action` input event scores one point, and any other event type is
rejected. It exists to exercise the generic adapter and acceptance pipeline; it
is not a production game.

## Jumpy Chewie transport translation

Jumpy Chewie's native replay contract is deliberately kept unchanged. At the
Worker boundary, the adapter translation normalizes its evidence into the
platform format before validation and storage:

| Jumpy Chewie | Platform canonical form |
| --- | --- |
| `timestamp_ms` | `t_ms` |
| `pickup_tap` | `tap_pickup` |
| numeric `pickup_id` | string `pickup_id` |
| `run_duration_ms` in canonical `game_stats` | replay timeline bound |
| active `run_duration` | stored run duration |

The translation does not calculate or approve scores. If simulator validation
is enabled, the `jumpy-chewie-2` simulator must reproduce the canonical
`game_stats` object and exact score. Otherwise the generic trusted path is used.

The development database includes the Jumpy Chewie game/ruleset metadata, and
the registry maps its exact `0.1.0` build to the remote simulator adapter. The
adapter is feature-flagged by `JUMPY_CHEWIE_SIMULATOR_URL`: when absent, the
trusted path is enabled; when present, simulator validation is enabled. An
unavailable configured simulator leaves requests pending rather than silently
falling back to trusted mode.

## Jumpy Chewie adapter requirements

The Jumpy Chewie `jumpy-chewie-2` adapter must return all of its authoritative
statistics inside `game_stats` and reproduce, without trusting the client's
final statistics:

- the authored rim contour and inset track;
- seeded tooth-pattern selection and rigid-ring movement;
- swipe buffering and Chewie target resolution;
- jump arc timing and tooth collision;
- landing gap/near-miss identity and combo rules;
- seeded pickup placement, collection, expiry, and activation effects;
- pause/resume timing and normal-run eligibility.

The Worker does not register a partial adapter. The concrete build adapter is
the exact-build simulator service described in
[`JUMPY_SIMULATOR_SERVICE.md`](JUMPY_SIMULATOR_SERVICE.md). It is optional and
can be enabled later without changing the generic leaderboard API.
