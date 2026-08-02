# Replay validation contract

The Worker accepts a run only through this sequence:

1. The client requests a short-lived server run session.
2. The Worker issues a run ID, nonce, seed, ruleset version, and build binding.
3. The client submits the final statistics and a timestamped input trace.
4. The Worker resolves a simulator by `(game, ruleset, build)`.
5. The simulator replays the trace from the issued seed.
6. The Worker compares every statistic in `REPLAY_STAT_KEYS`.
7. Only an exact match may be stored as `accepted` and appear on a leaderboard.

An unregistered simulator returns `pending`. A simulator that rejects the trace
or produces different statistics returns `rejected`. This is intentionally
fail-closed.

## Jumpy Chewie adapter requirements

The Jumpy Chewie `jumpy-chewie-2` adapter must reproduce, without trusting the
client's final statistics:

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
