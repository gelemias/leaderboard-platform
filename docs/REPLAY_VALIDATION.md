# Replay validation contract

The Worker accepts a run only through this sequence:

1. The client requests a short-lived server run session.
2. The Worker issues a run ID, nonce, seed, ruleset version, and build binding.
3. The client submits the final statistics and a timestamped input trace.
4. The Worker resolves a simulator by `(game, ruleset, build)`.
5. The simulator replays the trace from the issued seed.
6. The Worker compares `score` and the complete canonical `game_stats` object returned by the simulator.
7. Only an exact match may be stored as `accepted` and appear on a leaderboard.

An unregistered simulator returns `pending`. A simulator that rejects the trace
or produces different statistics returns `rejected`. This is intentionally
fail-closed.

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

The translation does not calculate or approve scores. The eventual
`jumpy-chewie-2` simulator must still reproduce the canonical `game_stats`
object and exact score before a run can become accepted.

The development database includes the Jumpy Chewie game/ruleset metadata, but
the registry intentionally has no Jumpy validator yet. Requests for that
combination therefore fail closed as `pending`; adding a fixture lookup or a
partial score formula here would weaken the anti-cheat boundary.

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

The existing Worker does not register a partial adapter. Until this contract is
implemented for a concrete build, those submissions remain pending and cannot
rank.
