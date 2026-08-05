# Build priority — the five 2026-08-05 analysis specs

Five specs went in today, all stretch-goal analysis/inference features layered on
top of the existing Stockfish + Maia setup:

- `2026-08-05-bayesian-rating-inference.md`
- `2026-08-05-maia-monte-carlo-rollouts.md`
- `2026-08-05-sprt-engine-ratings.md`
- `2026-08-05-policy-mixture-engine.md`
- `2026-08-05-maia-calibration-audit.md`

None of them are in the original build plan — this doc just says which order to
pick them up in for the hackathon demo, and why. Not a commitment that all five
get built; if time runs out, stop after #1.

## The order

### 1. Bayesian rating inference — build first

Highest demo payoff for the lowest risk. "You play like a 1400," live, updating
as the game goes — the single most ownable "wow" moment of the five, and a
judge can trigger it themselves instead of watching it happen. It's mostly
arithmetic over a model output Maia already produces, so the implementation
risk is low. Self-contained — doesn't need any of the other four.

Bonus: it needs a new `evaluateMaiaAt(fen, selfBucket, oppoBucket)` primitive
(today's `evaluateMaia()` reuses one rating for both self and opponent). Both
the rollouts spec and the calibration spec want the same shape of call, so
building this first hands the next two a head start instead of three separate
one-off helpers.

### 2. Maia Monte Carlo rollouts — build second, spike the risk first

Second-strongest live moment — a human-realistic win/draw/loss readout that
visibly differs from Stockfish's cp bar. But the spec flags one real unknown:
whether Maia's ONNX graph actually has a dynamic batch axis. That's a 10-minute
check (`session.run()` against a `[2,18,8,8]` input) — do that check *before*
writing the rest of the feature. If the axis isn't dynamic, the batching
approach needs a fallback (smaller N, serial with a lower ceiling) and that
changes how much of the spec is worth building at all.

### 3. Policy mixture engine — good demo value, biggest engineering lift

A genuinely new opponent to select and play against, which is a stronger demo
beat than "one more preset." But it's the largest surface area of the five:
turning on Stockfish MultiPV, aligning two different move vocabularies,
UI wiring across `EngineConfigPicker` / `engines.ts` / the preset lists, plus a
shared-worker MultiPV state leak the spec-writing agent already found while
drafting it. Its strength claim is also unfounded until SPRT (#4) validates it
— fine to ship labelled "experimental" if #4 hasn't landed yet.

### 4. SPRT engine ratings — valuable, but not a live-clickable feature

This is the one that actually closes an admission already sitting in
`docs/process/plans/2026-08-03-engine-room-implementation.md` (Task 2): the
`UCI_Elo` presets were never proven to change playing strength, only accepted
as options. Worth doing for real. But one match already costs ~30-40s of
engine thinking, and even a loose sanity-check SPRT decision needs ~22 games,
a tight one ~320 — that's a kick-off-in-the-background-and-check-later task,
not something to build under demo-day time pressure. Start it early *because*
it's slow, and treat its output as a shipped fixture rather than something
computed live.

### 5. Maia calibration audit — last, or in parallel, off to the side

Never touches the app — it's a standalone Node script producing a reliability
diagram and a Brier score. Real rigor, but it's a slide you show a judge, not
something they click. It also isn't a blocker for #1: ship the rating estimate
first and cite the calibration numbers afterward if they're ready in time,
rather than gating the demo feature on this landing.

## If time runs out

Ship #1 alone, done well. One playable feature beats all five done shallowly
— it's the only item on this list a judge interacts with directly instead of
having explained to them.
