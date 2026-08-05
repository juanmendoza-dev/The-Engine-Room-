# Bayesian rating inference — design

Turns the player's own moves in User 1v1 into evidence about their rating: a
posterior over Maia's 9 rating buckets, updated one ply at a time, instead of
a single number read off one move. Everything this needs already exists in
some form in this repo — Maia's policy head, the legal-move softmax, the
9-bucket scheme. This spec wires them into a likelihood function and is
explicit about where the assumptions break (moves in a game aren't
independent; the opponent's rating isn't always on Maia's scale) and what's
done about each.

## Scope

- Runs for **User 1v1** only, over the human's own plies — the opponent
  engine's moves carry no information about the human's rating and are never
  scored.
- **Model 1v1** has no human to rate; it's only useful here as a source of a
  known-ground-truth fixture for verification (a game where "the player" side
  is actually Maia at a known bucket).
- Purely descriptive and read-only. No training/fine-tuning of anything,
  ever (project hard constraint), and this never feeds back into engine
  behavior — the design doc's "adaptive opponent" stretch goal is a separate,
  heuristic feature, not this.

## Depends on

- **Whether Maia's softmax outputs are calibrated probabilities**, not just a
  usable arg-max — `2026-08-05-maia-calibration-audit.md`'s job, not this
  spec's. If that audit finds the outputs badly calibrated, this posterior is
  still measuring *something*, just not reliably "rating." The fallback
  isn't to patch this spec's math, it's to keep the credible interval wide by
  construction (Reporting).
- **`evaluateMaiaAt`, the per-bucket forward pass everything below needs,
  doesn't exist yet** (Interfaces). A small, mechanical split of code
  `evaluateMaia` already has — not a new integration risk, but a real
  prerequisite this document doesn't implement.

## The model, stated precisely

`r` ranges over the 9 named Maia buckets `{1100, 1200, ..., 1900}` —
categories 1-9 of `eloToCategory()` in `lib/chess/engineMaia.ts` (category 0
is "<1100", category 10 is ">=2000"; neither is a named preset, so both are
outside the prior's support). `o` is the opponent's bucket (see "The
elo_oppo problem"). `fen_t` is the position before the player's t-th own
move; `m_t` is the move played, in the `from+to+promotion` UCI form
`engineMaia.ts`'s move table already keys on. Both come straight off
chess.js's verbose history: `.before` is `fen_t`, `.lan` is that UCI string
(confirmed against the installed chess.js 1.4.0) — no manual snapshotting.

**Prior.** Flat over the 9 buckets: `P₀(r) = 1/9`. Deliberately
uninformative — a prior centered on 1500 converges faster but means the app
assumes every new player is average before it's seen one move.

**Likelihood.** `evaluateMaiaAt(fen, r, o)` runs one Maia forward pass with
`elo_self=r`, `elo_oppo=o` and returns the softmax of `logits_maia`
restricted to the legal moves at `fen` — exactly what `evaluateMaia` already
computes (its `legalLogits`/`exp`/`sum` block), parameterized on two
independent buckets instead of one reused value:

```
L_t(r) = P(m_t | fen_t, r, o) = evaluateMaiaAt(fen_t, r, o).policy[m_t]
```

Nine forward passes per ply, one per bucket, `o` fixed across all nine (it's
not a hypothesis being tested — see elo_oppo). *Real numbers, not invented:*
`docs/maia-notes.md` measured three of the nine buckets' reply to 1.e4 —
`g8f6` at 31.9% (1100), 29.3% (1500), 32.6% (1900). Three real `L_1(r)`
values, within 3 points of each other — the concrete shape of "one move is
weak evidence." The other six buckets are unmeasured here.

**Log-space accumulation.** Multiplying 20-30 of these underflows fast, so
the running state is a log-posterior, one number per bucket:

```
ℓ₀(r) = log P₀(r) = -log 9
ℓ_t(r) = ℓ_{t-1}(r) + β_t · log max(L_t(r), ε)      ε = 1e-6, floors log(0)
```

`β_t = τ · g_t`: tempering (`τ`, constant per game) times an
information-gain weight (`g_t`, per ply) — both below. `β_t = 0` makes the
update a no-op, which is how a skipped ply works: a weight of zero, not a
branch.

**Normalization**, read-time only — the same subtract-the-max-before-`exp`
trick `evaluateMaia` already uses for its own softmax, applied to 9
log-posteriors instead of ~30 move logits:

```
P(r | m₁..m_t) = exp(ℓ_t(r) − LSE_t)     LSE_t = log Σ_r' exp(ℓ_t(r'))
```

This is a repurposing, not a new model: `getMaiaMove` fixes `elo_self` and
searches over moves; this fixes the move played and searches over
`elo_self`. Same `P(move | position, elo_self, elo_oppo)`, read backwards.

## The independence assumption is wrong

Treating the player's ~20-30 moves as independent draws from
"Maia-at-bucket-r" and multiplying their likelihoods is exactly the model
above, and it's wrong: moves in one game are correlated. A player in book
plays several theory-consistent moves for one shared reason (they know the
line), not ten independent re-rolls of "does this look like a 1500." A
player who blunders under time pressure at move 25 is often still rattled at
move 27. The plies are not exchangeable observations — they're one game's
worth of a much smaller number of "real" independent decisions wearing
20-30 plies of clothing.

The symptom: naive multiplication collapses the posterior toward one bucket
at ~100% far faster than the actual evidence justifies. Not wrong in
*direction* — it's wrong in *magnitude*: the interval narrows like it saw 25
independent trials when it saw something closer to 8.

**Mitigation: a tempering exponent.** Raise each per-ply likelihood to a
power `τ ∈ (0,1]` before it enters the log-posterior (the `τ` in
`β_t = τ·g_t`). `τ=1` is the naive, overconfident version; `τ<1` discounts
every ply uniformly, equivalent to pretending the game had `τ · (own plies)`
truly independent moves rather than that many raw plies — a standard move in
the Bayesian-robustness literature (power likelihoods, tempered posteriors)
for correlated data fed into an i.i.d.-assuming model.

**`τ` is a tuned fudge factor, not a derived quantity** — nothing in this
repo measures how correlated one game's moves actually are. Starting guess:
`τ ≈ 0.35` (a 40-ply game behaves like ~7 independent observations), tuned by
watching the self-consistency check (Verification) converge, not derived
from data. If `2026-08-05-move-surprisal.md` ends up computing per-ply
surprisal across real games, its autocorrelation would be a more principled
way to set `τ` — worth revisiting then.

## Information-gain weighting

Some plies carry no signal — early book moves every bucket plays the same
way, and any position with exactly one legal move, no matter how the buckets
differ elsewhere. Folding those in at full weight adds drag on convergence,
not evidence.

**Mutual information at a position.** Under the running posterior `P(r)`
(the state *before* this ply, so a ply never weights itself), the 9
buckets' policies mix into a reference distribution:

```
P̄(m | fen) = Σ_r P(r) · P(m | fen, r, o)
```

and the mutual information between "which bucket" and "which move" here is
the posterior-weighted KL divergence of each bucket's policy from that
mixture, in nats — free from the same 9 policies the likelihood step already
computed, not a 10th call:

```
I(fen) = Σ_r P(r) · Σ_m P(m | fen, r, o) · log[ P(m | fen, r, o) / P̄(m | fen) ]
```

**The one-legal-move case falls out for free.** With exactly one legal move
`m*`, softmax over a single logit is always 1 regardless of its value, so
every bucket gives `P(m*|fen,r)=1`, `P̄(m*|fen)=1`, every `log(1/1)=0`, and
`I(fen)=0` exactly — no special-cased branch needed.

**Turning `I(fen)` into a weight** — two more tuned guesses:

```
g_t = 0                       if I(fen_t) < I_min   (I_min = 0.02 nats — skip)
g_t = min(1, I(fen_t)/I_ref)   otherwise              (I_ref = 0.25 nats — full weight)
```

**How much this helps: unmeasured.** Expected to matter most in the opening
(all three checked buckets pick `g1f3` first in `docs/maia-notes.md`'s
numbers) and least in a messy middlegame. "Cuts plies-to-converge by maybe a
third" is a plausible guess, not a measurement — there's no corpus of graded
games here to check it against.

## The elo_oppo problem

Maia takes both ratings as input, and today's interface can't express them
independently: in `evaluateMaia`, `config.ratingTier` becomes *both*
`elo_self` and `elo_oppo` (`lib/chess/engineMaia.ts` — one `category`, reused
for both tensors). Fine for gameplay (Model 1v1's "we both think we're this
rating" is good enough to pick a move); wrong for inference, where
`elo_self` is the hypothesis being swept and `elo_oppo` must stay fixed at
the real opponent. `evaluateMaiaAt(fen, selfBucket, oppoBucket)` (Interfaces)
splits the two.

**Known case: opponent is a Maia preset.** `MAIA_PRESETS`
(`lib/chess/engines.ts`) carry an exact `ratingTier` — `eloToCategory` of it
is the bucket, no guessing.

**Unknown case: opponent is Stockfish.** `STOCKFISH_PRESETS` carry a UCI
`elo` (1320/1800/2800) on a different scale with no principled conversion to
Maia's human-imitation buckets. Two options:

- **Fix to a default (recommended).** Round the Stockfish `elo` to the
  nearest of the 9 buckets, clamped to [1100,1900]: 1320→1300, 1800→1800,
  2800→1900 (a real approximation at the ceiling — Maia's scale doesn't
  reach 2800). No number at all → flat 1500. One lookup, no extra passes,
  and honest about being an approximation.
- **Marginalize:** `P(m|fen,r) = Σ_o P(o)·P(m|fen,r,o)`. Cleaner, but 9× the
  per-ply cost (Cost) for a parameter that's plausibly second-order — whether
  `elo_oppo` moves the policy much independent of `elo_self` hasn't been
  measured here (`docs/maia-notes.md`'s responsiveness check varied only
  `elo_self`). Not recommended unless the calibration audit says otherwise.

## Reporting

```
mapBucket = argmax_r P(r | data)
```

**Credible interval**, kept contiguous and legible ("1300-1700"): start at
`mapBucket`, greedily extend to whichever neighboring bucket holds more mass,
until covered mass reaches 80%:

```
lo = hi = index of mapBucket; mass = P(mapBucket)
while mass < 0.80 and (lo > 0 or hi < 8):
  extend toward whichever of bucket[lo-1]/bucket[hi+1] has more mass
  mass += that bucket's probability
report [bucket[lo], bucket[hi]], actual mass reached as `coverage`
```

Assumes a roughly unimodal posterior — true for basically any real game, but
a genuinely bimodal one gets papered into one contiguous band. Worth
knowing, not worth solving here.

**Confidence tightens with ply count** two visible ways: the interval
narrows, and `effectivePlies` (`Σ g_t`, not raw plies) grows — report both,
since effective-plies explains why a long-theory game narrows slower than one
that left book by move 4.

**Honest presentation** — per `docs/design/ink-and-bone-notes.md`'s
header-scoreboard rule ("the badge wasn't ugly, it was untrue"): never a
bare number.

- Below a minimum `effectivePlies` (gate, e.g. 3.0 — a guess), show nothing
  conclusive — a muted "reading your moves…" placeholder.
- Past the gate, show the interval with the MAP bucket picked out ("plays
  like **1500** · likely 1300-1700") plus effective-plies, and let the
  interval visibly shrink rather than snapping to a hard number early. A
  bare number with no interval at ply 4 is exactly what the scoreboard badge
  was retired for.
- Never "your rating" outright — "plays most like a 1300-1700 player," not
  "your rating is 1500."

## Cost

Nine forward passes per ply, sequential by default: 9 × ~35-55ms observed
elsewhere in this repo (35ms, `docs/maia-notes.md`; 47-55ms on different
hardware, `docs/reviews/task-03-maia-review.md`) ≈ 315-500ms — call it ~400ms.
Marginalizing `elo_oppo` instead of fixing it would make this 9×9=81 passes,
~2.8-4.5s per ply — the concrete reason that's not the default.

**Where it runs.** Client-side, same as both engines — no server-side
inference anywhere in this app. Must stay **off the move-response path**:
fire `updateRatingEstimator` after the move is already committed to state,
into its own slot, not awaited inline in `onPieceDrop`.

**Sharper risk than "don't await it": main-thread contention.**
`engineMaia.ts`'s ONNX session is a module-level singleton on single-threaded
wasm on the main JS thread — no Worker for Maia today, unlike Stockfish. Not
awaiting the result doesn't stop ~400ms of `session.run()` calls from
occupying the one thread React and the opponent engine also need; worth
yielding between buckets (`setTimeout(0)` between each of the 9) rather than
firing them as one unbroken stretch. A Worker would remove the problem
outright but is bigger than this spec's budget, and whether concurrent
`session.run()` calls on one session even interleave safely is unverified —
sequential `await` is the assumed-safe default.

**Batching.** If `2026-08-05-maia-monte-carlo-rollouts.md`'s batching lands,
the 9 calls should collapse into one `session.run()` with a batch dimension
(`boards` as `[9,18,8,8]`, `elo_self`/`elo_oppo` as `[9]`). Speculative:
today's tensors are hard-coded to batch size 1, and I haven't run this graph
at batch>1 to confirm it has a usable batch dimension at all.

## Interfaces

Prerequisite, not implemented here — a small split in the existing wrapper:

```ts
// lib/chess/engineMaia.ts — new export, reusing evaluateMaia's tensor-
// building and legal-move softmax with two independent category tensors
// instead of one reused value. evaluateMaia(fen, config) becomes a 1-line
// wrapper: evaluateMaiaAt(fen, cat, cat), cat = eloToCategory(config.ratingTier ?? 1500).
export async function evaluateMaiaAt(
  fen: string,
  selfBucket: number,   // 1-9, an eloToCategory() output — not a raw ELO
  oppoBucket: number,
): Promise<MaiaEvaluation>
```

New, under `lib/analysis/` — consumes `EngineConfig` from
`lib/chess/types.ts` and `MaiaEvaluation` from the extended `engineMaia.ts`:

```ts
// lib/analysis/maiaLikelihood.ts
export const MAIA_RATING_BUCKETS = [1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900] as const;
export type RatingBucket = (typeof MAIA_RATING_BUCKETS)[number];

/** One evaluateMaiaAt call per bucket, oppoBucket fixed. The ~400ms cost (Cost). */
export async function policiesForAllBuckets(
  fen: string,
  oppoBucket: RatingBucket,
): Promise<MaiaEvaluation[]>;  // index-aligned with MAIA_RATING_BUCKETS

/** L_t(r) per bucket. Floored to ε at the call site, not here. */
export function likelihoodsForMove(policies: MaiaEvaluation[], playedUci: string): number[];

/** I(fen) in nats, under `posterior` as the weight on each bucket — reuses
 * policiesForAllBuckets's output, not a 10th forward pass. */
export function moveMutualInformation(policies: MaiaEvaluation[], posterior: number[]): number;
```

```ts
// lib/analysis/ratingPosterior.ts
import type { EngineConfig } from "@/lib/chess/types";
import type { RatingBucket } from "./maiaLikelihood";

export interface RatingEstimatorState {
  logPosterior: number[];   // index-aligned with MAIA_RATING_BUCKETS, unnormalized
  oppoBucket: RatingBucket;
  effectivePlies: number;   // Σ g_t
  totalPlies: number;
}

/** Maia opponent → exact bucket; Stockfish → nearest, clamped; else 1500. */
export function resolveOppoBucket(opponent: EngineConfig): RatingBucket;

export function createRatingEstimator(oppoBucket: RatingBucket): RatingEstimatorState;

/**
 * Folds one of the player's own moves in. `fenBefore`/`playedUci` come
 * straight off chess.js: `game.history({verbose:true}).at(-1)!.before`/`.lan`.
 * Runs up to 9 forward passes (policiesForAllBuckets) — keep off the
 * move-response path (Cost).
 */
export async function updateRatingEstimator(
  state: RatingEstimatorState,
  fenBefore: string,
  playedUci: string,
): Promise<RatingEstimatorState>;

export interface RatingReport {
  probabilities: number[];
  mapBucket: RatingBucket;
  credibleInterval: { low: RatingBucket; high: RatingBucket; coverage: number };
  effectivePlies: number;
  totalPlies: number;
  ready: boolean;  // effectivePlies past the display gate — see Reporting
}

export function summarizePosterior(state: RatingEstimatorState): RatingReport;
```

**Call site** (proposed, not wired up): `app/user-1v1/page.tsx`'s
`onPieceDrop`, after the human's own `game.move(...)` succeeds —
fire-and-forget into its own state slot; `resolveOppoBucket(engine)` runs
once in `start()`.

**Shares ground with `2026-08-05-move-surprisal.md`**, which likely wants the
same `P(move|position,bucket)` primitive (surprisal is `-log` of one bucket
instead of 9 swept) — build `evaluateMaiaAt` once for both rather than risk
two copies drifting apart, the way the move table and model almost did
(`docs/maia-notes.md`'s "hypothesis I had, and disproved").

## Verification

No automated test suite in this repo — every check is a manual action, in
the spirit of `scripts/cdp-verify.mjs`.

1. **Self-consistency (strongest, and cheap).** Play a game where one side is
   Maia fixed at a known bucket (e.g. the 1700 preset). Feed that side's own
   `(before, lan)` pairs through `createRatingEstimator`/`updateRatingEstimator`
   with `oppoBucket` set to whatever the other side resolves to. Confirm
   `mapBucket` converges to 1700 and the interval tightens around it. The
   estimator's generative model *is* Maia, so this is a real test of whether
   it recovers a ground truth it has no excuse to miss. Deliverable: a script
   (`scripts/verify-rating-posterior.mjs`) that drives such a game and logs
   the posterior every ply.
2. **One legal move.** Hand-construct a FEN with exactly one legal move.
   Confirm `moveMutualInformation` ≈ 0 and `g_t` computes to 0 — check the
   actual numbers, not just the derivation above.
3. **No evidence, no claim.** `summarizePosterior` on a fresh estimator:
   confirm flat `probabilities`, `ready=false`, interval spanning all 9
   buckets.
4. **Sensitivity to a wrong `elo_oppo` default.** Re-run check 1 with a
   deliberately wrong `oppoBucket`. If `mapBucket` still converges to 1700,
   "fix to a default" is safe in practice; if it drags off, that's a signal
   marginalizing is worth its 9× cost.
5. **Tempering, by eye.** Run check 1's fixture with `τ=1` vs the chosen `τ`.
   Confirm `τ=1` collapses to ~100% on one bucket in visibly fewer plies —
   that's what "overconfident" looks like, and a check that `τ` isn't so low
   the estimator never resolves anything either.

## Risks

- **Calibration is unverified by this spec** — everything above assumes
  Maia's softmax behaves like a genuine probability in `elo_self`. See
  `2026-08-05-maia-calibration-audit.md`.
- **50% top-1 accuracy means weak per-move signal**, which is why this leans
  on dozens of plies — and why a mis-set `τ` compounds in the same direction
  across all of them.
- **Main-thread contention** (Cost) — a real stall risk, not just latency.
- **Distribution shift.** Maia was trained on lichess/chess.com human games;
  an atypical repertoire or deliberately unusual-but-not-weak play reads as a
  worse or different fit than actual strength — this measures which bucket's
  move distribution you resemble, correlated with rating but not identical.
- **The model's own opening quirk** — `maia_rapid.onnx`'s measured
  knight-heavy opening prior (`docs/reviews/task-03-maia-review.md`, Q3) looks
  constant across buckets as far as anyone's checked, but that's unverified;
  if it varies by bucket, early plies carry a skill-unrelated bias.
- **Short games** may never cross the `effectivePlies` gate — it can't tell
  "few plies, low information" from "few plies, one huge blunder" apart, so
  many short games show nothing at all. Intended failure direction, still
  worth knowing.
- **Every constant named here** (`τ`, `I_min`, `I_ref`, 80% coverage, the
  display gate) **is a starting guess**, not derived or measured.

## Out of scope

- Training or fine-tuning anything — inference only, over the existing
  released `maia_rapid.onnx`.
- Feeding this back into engine behavior — the design doc's "adaptive
  opponent" stretch goal is a separate, heuristic feature.
- Marginalizing `elo_oppo` — the costlier alternative, not the default.
- Batching the 9 passes into one call — depends on
  `2026-08-05-maia-monte-carlo-rollouts.md`.
- Moving Maia inference into a Web Worker — named as the real fix for
  main-thread contention, not undertaken here.
- Wiring into Model 1v1 (no human to rate) or the history page — the only
  named integration point is `/user-1v1`, and it's proposed, not implemented.
- Any UI beyond the presentation rules in Reporting.
