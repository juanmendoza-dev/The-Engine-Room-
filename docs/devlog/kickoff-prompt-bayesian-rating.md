# Kickoff prompt: build the rating-estimate feature (Task 13)

```
You're picking up work on "The Engine Room" — a chess web app (watch two
engines play each other, or play one yourself). If this repo isn't already
your working directory, clone it first:
https://github.com/juanmendoza-dev/The-Engine-Room-.git

Your job is ONE feature: infer a player's rating live from the moves they
play, using Maia as a human-move-prediction model, and show it as a posterior
distribution over rating buckets that gets more confident as the game goes
on. Elevator pitch: "you play like a 1400" — but honest about uncertainty
early in the game, per this repo's own documented allergy to UI that claims
more than it can back.

This was picked as the first of five 2026-08-05 stretch specs to build (see
docs/superpowers/specs/2026-08-05-build-priority.md) because it's the
highest demo payoff for the lowest implementation risk, and it doesn't
depend on any of the other four.

Before doing anything else, in this order:

1. Read AGENTS.md in the repo root. Non-negotiable rules: signed commits, no
   AI co-author attribution, commit small and often, human-sounding commit
   messages, expand docs whenever you learn something.

2. Read docs/deployment.md — the branch workflow, the feat/NN-slug naming,
   and the per-clone setup, just as mandatory as AGENTS.md. Do the setup for
   this clone:

   git config core.hooksPath .githooks
   git config user.signingkey C:/Users/juanm/.ssh/id_ed25519_polyquant.pub
   git config --show-origin --get user.signingkey   # must say file:.git/config

   Without the local signingkey override, commits sign fine locally but land
   on GitHub as Unverified.

3. Read docs/superpowers/specs/2026-08-03-engine-room-design.md — the base
   architecture, and more importantly the constraints that still bind on
   this feature: chess.js is the sole authority on legality/game-end, NO
   training or fine-tuning of any model, ever (this feature is pure
   inference over Maia's existing outputs — if anything you're building
   starts to look like it's adjusting weights, stop and flag it, don't
   build it), zero budget, both engines client-side, no accounts.

4. Read docs/superpowers/specs/2026-08-05-bayesian-rating-inference.md in
   full. This is the actual spec — formulas, interfaces, and the
   verification plan all live there. Read the whole thing yourself rather
   than working from a paraphrase.

5. Read scripts/maia-notes.md, then lib/chess/engineMaia.ts,
   lib/chess/engines.ts, lib/chess/types.ts, and lib/chess/gameLoop.ts. The
   spec builds directly on top of these — know the actual current shape of
   the code before changing anything.

## The one thing you cannot skip

lib/chess/engineMaia.ts's evaluateMaia() currently sets elo_self and
elo_oppo to the SAME value (it reuses config.ratingTier for both tensor
inputs). This feature needs to score a hypothesis bucket against a FIXED,
DIFFERENT opponent bucket, so a new entry point — the spec proposes
something like evaluateMaiaAt(fen, selfBucket, oppoBucket); read the spec
for its exact proposed shape — is a real prerequisite, not a detail. Build
it and verify with your own eyes that it actually returns different output
for different elo_oppo values before building anything on top of it. Don't
assume the tensor plumbing works just because it compiles.

## Two things the spec itself flags as unproven — don't treat them as settled

- The tempering exponent (the spec calls it τ, proposes ≈0.35) that corrects
  for treating consecutive moves as independent evidence is a TUNED FUDGE
  FACTOR, not a derived quantity. Treat the spec's number as a starting
  point and sanity-check it against the self-consistency test below rather
  than shipping it blind.
- The MAP/credible-interval reporting is gated on an "effective plies" count
  specifically so the UI never shows a confident-looking number early in a
  game. This isn't a nice-to-have — it's the same rule that killed the old
  "Live · engines coupled" badge (docs/design/ink-and-bone-notes.md, "Header
  scoreboard" section) for claiming something the app couldn't back. Do not
  ship a bare percentage on ply 2.

## One dangling reference to ignore

The spec cross-references a file named 2026-08-05-move-surprisal.md. That
spec was never actually written — it was named during initial planning as a
possible future sibling and nothing else exists for it. Don't go looking
for it and don't block on it.

## Interfaces and scope

Follow the spec's proposed file layout under lib/analysis/ and its proposed
function signatures unless you find a concrete reason in the actual
codebase to deviate — if you deviate, say why in a commit message or a doc
update, per AGENTS.md's documentation rule.

Keep the UI surface deliberately minimal, per the spec's own instruction —
this is a compute-layer feature. A simple, honest readout (bucket + interval
+ a "still figuring you out" state at low ply count) is the right scope; if
it needs any visual styling at all, reuse the existing --er-* tokens
(docs/design/ink-and-bone-notes.md) rather than inventing new ones. Don't
build a dashboard.

Existing behavior must not change: getMaiaMove and the existing
evaluateMaia, as called from the live game loop, must stay byte-identical.
If you need shared logic (legal-move filtering, softmax), factor it into a
helper both the old and new code call — don't fork it.

## Branching

This is Task 13 — the original plan's 12 tasks are all done, and the other
four 2026-08-05 specs would logically be 14-17 if anyone picks them up
later. Check git log / gh pr list before trusting that numbering is still
accurate by the time you read this, someone may have already claimed a
number. Branch as feat/13-<your-slug>, per docs/deployment.md's naming
convention. Never commit to main. Small commits, pushed often, PR via
gh pr create --fill per the usual loop.

## Verification

No automated test suite in this repo — every check is a concrete manual
action, deliberately (see the base design doc's Testing section). The
spec's own verification plan is the bar. At minimum, run its self-
consistency check: feed the estimator a sequence of moves that were
themselves GENERATED by Maia at a known rating bucket, and confirm the
posterior actually converges on that bucket. That's the strongest cheap
check available and it's explicit in the spec — don't substitute a weaker
one.

## When you're done

Append a "Task 13" section to
docs/superpowers/plans/2026-08-03-engine-room-implementation.md, in the same
voice and shape as the existing Task 12 (Fight FX) entry — done state,
what differed from the spec, verification results actually observed. That's
the established pattern in this repo for stretch work landed outside the
original plan; don't invent a different format for it.

## Stop here

Do not start implementing yet. Once you've read everything above and the
full spec, write up a short implementation plan: the exact files you'll
create or touch, the exact signature for the new evaluateMaia-at-a-fixed-
opponent-bucket entry point, and how you're resolving each item the spec
explicitly flags as a guess or an open question — find them, don't skip
past them. Then stop and wait for a go-ahead before writing code.
```
