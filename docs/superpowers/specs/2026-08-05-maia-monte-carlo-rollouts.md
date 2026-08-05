# Maia Monte Carlo Rollouts — Design

Spec for estimating a *human-realistic* win/draw/loss probability at a
position: sample N full playouts from it, using Maia as the move policy for
both sides, and count how they end. Stockfish's centipawn score answers "what
happens under best play" — objective truth, but not what a human game at a
given rating actually tends to do. This spec answers the second question.
It's a compute-layer spec, not a UI one. Written 2026-08-05, alongside three
sibling specs touching the same engine layer:
`2026-08-05-bayesian-rating-inference.md`, `2026-08-05-engine-worker-pool.md`,
and `2026-08-05-move-surprisal.md` — cross-referenced inline where relevant.

## Goals / constraints

- Estimate P(win)/P(draw)/P(loss) for the side to move, by playing N
  independent full games forward from the FEN with Maia choosing every move
  for both sides, then counting outcomes.
- **Flat Monte Carlo rollout estimation, not MCTS.** No search tree, no node
  reuse, no UCB/PUCT selection between rollouts — every rollout is an
  independent sample from the root, which is what makes the standard
  proportion-confidence-interval statistics below valid. Worth saying
  plainly, since "Monte Carlo" in chess usually implies tree search.
- **Additive only.** `getMaiaMove` and the live Model 1v1 / User 1v1 game
  loops keep working exactly as today — same argmax behavior, same call
  sites. Everything here is a new export on a new, separate code path.
- No training or fine-tuning — inference only. Zero budget: still
  onnxruntime-web wasm client-side, no server compute.
- chess.js stays sole authority on legality and game end — every rollout
  reuses `chess.moves()` and `describeEnd` (from `lib/chess/gameLoop.ts`),
  no separate rules logic.

## What exists today (the diff is against this)

`evaluateMaia(fen, config)` in `lib/chess/engineMaia.ts` builds a single
`[1, 18, 8, 8]` tensor via `boardToTensor`, plus `elo_self`/`elo_oppo` as
length-1 `BigInt64Array`s, runs one `session.run()`, and softmaxes
`logits_maia` over legal moves only. `getMaiaMove` takes `policy[0]` — the
top move. That's argmax: deterministic, which is right for a live game and
wrong for rollouts, where N identical top-move games would tell you nothing.

Worth knowing before touching this code: **`elo_self` and `elo_oppo` are
always the same value today.**

```ts
elo_self: new ort.Tensor("int64", BigInt64Array.from([category])),
elo_oppo: new ort.Tensor("int64", BigInt64Array.from([category])),
```

The model is never told what rating it's actually facing — just "you and
your opponent are the same rating." Pre-existing (simplification or
oversight, the source doesn't say), not introduced here. It matters because a
rollout asking "how does a 1500 fare against a 1900" needs `elo_oppo` to carry
the real opposing rating per side — the input
`2026-08-05-bayesian-rating-inference.md` would produce or consume. This spec
only makes the batched path accept an opponent rating distinct from the
mover's own; it doesn't choose ratings itself.

## Batched inference

The whole feature hinges on this: batch N positions into one
`[N, 18, 8, 8]` tensor so N rollouts advance one ply per forward pass instead
of one forward pass per rollout per ply.

**New, additive export in `engineMaia.ts`:**

```ts
export async function evaluateMaiaBatch(
  rows: { fen: string; config: EngineConfig; oppoRatingTier?: number }[]
): Promise<MaiaEvaluation[]>
```

- `boards`: one `Float32Array(N * 18 * 64)`, each row filled by the existing
  `boardToTensor(fen)` (unchanged) via `.set(tensor, i * 1152)`. Shape
  `[N, 18, 8, 8]`.
- `elo_self`/`elo_oppo`: `BigInt64Array` of length N via the existing
  `eloToCategory` (unchanged); `elo_oppo` reads `oppoRatingTier ??
  config.ratingTier` per row, fixing the same-value quirk above without
  changing what the single-position path does.
- One `session.run({ boards, elo_self, elo_oppo })` for the whole batch.
- **Assumed, not verified: output layout.** `outputs.logits_maia.data` is
  presumably flat row-major `[N, V]` (standard ONNX convention) — row *i* is
  `data.subarray(i*V, (i+1)*V)`, V = policy width (1880 per the move table in
  `scripts/maia-notes.md`, but read `outputs.logits_maia.dims` at runtime
  rather than hardcoding it). `logits_value` is one scalar per row. This is
  the standard layout and likely right, but nobody has run this graph at
  batch size >1 — verify before trusting anything downstream.
- The legal-move/softmax logic inline in `evaluateMaia` gets extracted into a
  shared helper, called once by the existing single-position path and N
  times by the batched path — a pure extraction, not a behavior change.
  `evaluateMaia`/`getMaiaMove` keep producing byte-identical output.

**Single biggest unknown this spec is built on:** whether the graph's batch
axis is actually dynamic, or was exported hardcoded to 1 (common for models
nobody expected to batch). If hardcoded, `evaluateMaiaBatch` as specified
won't run at all — spike this (feed a `[2,18,8,8]` tensor, see what happens)
before writing anything downstream of it.

**Finished-rollout masking.** Rollouts don't all end on the same ply. A
finished row keeps resubmitting its last real FEN (output discarded, not fed
back into play), so the tensor shape stays fixed `[N, ...]` for the whole
rollout — no reshaping mid-flight. A parallel `alive: boolean[N]` gates which
rows get sampled from and written back to their chess.js instance after each
shared pass. This wastes some compute on finished rows (they still cost
FLOPs), which is the simple, correct-first choice; compacting live rows into
a smaller tensor would save that but reopens the dynamic-batch-size question
above, so it's a later optimization, not MVP.

## Sampling: temperature instead of argmax

```ts
export function sampleFromPolicy(
  policy: { uci: string; probability: number }[], // legal-only, renormalized
  temperature: number,
  rng: () => number = Math.random
): string
```

Raise each renormalized probability to `1/temperature`, renormalize again,
sample by cumulative sum against `rng()`. This is mathematically identical
to dividing raw logits by `temperature` and re-softmaxing over the same
legal subset — the pre-renormalization constant cancels exactly — so
temperature sampling is a pure function on the `policy` array already
returned by `evaluateMaia`/`evaluateMaiaBatch`, no raw logits needed.
`temperature = 0` is a special case (argmax; `1/0` is undefined), which
doubles as a test: `sampleFromPolicy(policy, 0)` must equal `policy[0].uci`.
The same per-ply `policy` array is the natural input for
`2026-08-05-move-surprisal.md` (how unlikely a played move was under the
model) — no code shared between the two specs, but the same underlying
number, computed once per ply either way.

What temperature does to the estimate:

- **T → 0**: today's argmax. Rollouts collapse to one identical game —
  variance is zero, but the number measures "the top-policy line," not "what
  a population of humans does." Wrong tool for this job.
- **T = 1** (default): samples exactly the distribution Maia was
  cross-entropy-trained to match real human move frequencies — the
  principled default, not an arbitrary pick.
- **T > 1**: flattens toward uniform, injecting more randomness than real
  humans show — inflates variance (needs larger N for the same width) and
  biases the estimate toward "random legal move."
- **T < 1**: sharpens toward argmax — rollout spread shrinks, but that's an
  artifact of suppressing real behavioral variance, not genuine precision.

## Termination

A rollout runs until chess.js says it's over (`describeEnd`, reused) or hits
a **ply budget**, whichever first. Two different numbers, two purposes:

- **Ply budget (hard cap): 120 plies.** All N rollouts share one forward
  pass per ply, so the batch only finishes as fast as its slowest member —
  this bounds a pathological long shuffle. 120 is generous enough that most
  games resolve (checkmate, or chess.js's own 50-move/repetition rules)
  well before it binds.
- **~40 plies** is this spec's *typical*-length assumption for the cost
  numbers below — the number the assignment itself used, kept consistent
  with it rather than independently asserting a researched average game
  length.

**Decision: truncated rollouts are bootstrapped from `logits_value`, not
scored unknown.** Discarding them instead would bias the sample: rollouts
most likely to hit the ply budget are exactly the grindy, drawish, hard-to-
convert positions, so throwing them out systematically strips draws and long
defensive holds from the result, skewing it decisive. Bootstrapping avoids
that at the cost of trusting the value head.

**The bias this introduces:** `scripts/maia-notes.md` confirms Maia 2's
`logits_value` has the correct *sign* (verified: start position `-0.1813`,
white up a queen `+0.4583`) but **no established transform to a win
probability** — directional, not calibrated. (Maia 2's single scalar, not
Maia 3's separate loss/draw/win logits — this repo runs Maia 2.) Converting
it to a {win, draw, loss} contribution needs a squashing function whose
constants are a guess, flagged as such rather than asserted. That guess lands
exactly on the hardest-to-classify rollouts. Mitigation: report
`truncated / n`, and treat the interval as compromised once that climbs past
roughly 10–15%.

## The statistics

**Estimator:** each rollout is an independent draw from {win, draw, loss}
(root side to move). Point estimate is the sample proportion p̂ = count/N per
category — the MLE for a multinomial parameter given N iid draws.

**Interval: Wilson score per category, not naive Wald** (p̂ ± z·√(p̂(1−p̂)/N)).
Wald degrades badly near p̂ = 0 or 1 — exactly where this feature spends a lot
of its time. At p̂ = 1 (every rollout won, the mate-in-1 degenerate case
below), Wald collapses to a zero-width `[100%, 100%]`; Wilson doesn't:

| N (rollouts) | Wilson CI at p̂ = 1.0 (e.g. 30/30) | Wilson CI at p̂ = 0.5 (worst-case width) |
|---|---|---|
| 30  | [88.6%, 100%] | [33.2%, 66.8%] (±16.8 pts) |
| 100 | [96.3%, 100%] | [40.4%, 59.6%] (±9.6 pts)  |
| 300 | [98.7%, 100%] | [44.4%, 55.6%] (±5.6 pts)  |

(z = 1.96, 95%, computed directly from the Wilson formula.) Away from the
extremes the two methods roughly agree (Wald at p̂=0.5, N=30: ±17.9 pts, close
to Wilson's ±16.8); they diverge sharply at the extremes, which is the whole
reason to prefer Wilson here.

**N vs. width:** half-width scales roughly as 1/√N — N=30→100 (3.3×) tightens
worst-case width by √3.3≈1.8×; N=100→300 (3×) tightens it by √3≈1.7×. Halving
the interval takes roughly 4× the rollouts, not 2×.

**Simplification flagged:** treating each category as its own binomial
proportion ignores that all three sum to 1 — a simultaneous multinomial
interval (e.g. Goodman) would be more rigorous. Per-category Wilson is the
pragmatic MVP choice, not an oversight.

**Rollout variance dominates model error at these N.** The interval above
captures exactly one uncertainty source: having sampled only N games out of
the space of possible continuations. It says nothing about whether Maia's
policy faithfully models real human play at that rating (checked only
qualitatively in `scripts/maia-notes.md`), or about the value-bootstrap guess
above. At N in the 30–300 range this spec budgets for, the 1/√N sampling term
is large and dominates any structural model bias. A wider interval is the
honest fix for "not enough rollouts"; no amount of narrowing it fixes Maia's
fidelity to real human play, a separate, unquantified error source this
feature inherits and can't correct.

**Perspective:** "win" always means the root's side to move (`chess.turn()`
on the starting FEN) eventually won — a rollout continuing as the other
color needs its chess.js `1-0`/`0-1` sign-flipped relative to that root side.
Exactly the class of bug this codebase's mirroring code has hit before; the
mate-in-1 check below is designed to catch it.

## Cost model

New module: `lib/chess/maiaRollout.ts`, consuming `evaluateMaiaBatch` /
`sampleFromPolicy` from `engineMaia.ts` and `describeEnd` from `gameLoop.ts`.
Orchestrates N `Chess` instances, the alive-mask, and the statistics above;
`engineMaia.ts` stays purely about the ONNX call shape.

**Wall-clock, floor case** (assume zero raw-compute benefit from batching —
budget against this, treat better as upside):

| N | Serial (today's shape, looped) | Batched, floor | Batch tensor memory |
|---|---|---|---|
| 30  | 30×40×35ms ≈ 42s | ≈ 42s (same floor) | ≈ 138 KB |
| 100 | 100×40×35ms ≈ 140s (≈2.3 min) | ≈ 140s (same floor) | ≈ 461 KB |
| 300 | 300×40×35ms ≈ 420s (7 min) | ≈ 420s (same floor) | ≈ 1.4 MB |

N chess.js instances cost a few KB each — negligible even at N=300. The
"batched, floor" column matches serial on purpose: total FLOPs is conserved,
so if the backend gets zero extra throughput from a larger batch, batching's
only *guaranteed* win is collapsing N×plies sequential awaits into ~plies of
them (~4,000 round trips down to ~40 at N=100) — good for scheduling and
code simplicity, not necessarily wall clock. The real case for building this
rests on the backend beating the floor — plausible (CPU matmul workloads
often get real gains from batching; 35ms at N=1 likely includes fixed
marshalling overhead a bigger batch amortizes) but **never measured for this
model on this backend.** First empirical task once batching lands: measure
real per-ply latency at N=30/100/300 against this floor.

**Main thread, for now, flagged as a risk.** `engineMaia.ts` has no Worker
wrapper today (unlike Stockfish's dedicated worker) — the single-threaded
wasm backend runs synchronously inside the `session.run()` call, imperceptible
at N=1's 35ms but a real jank risk at the hundreds-of-ms-to-seconds the floor
case allows, repeated once per ply. Building batching on the main thread
first keeps this spec's own risk (dynamic batch axis) isolated from worker
plumbing; if latency lands near the floor, moving to a worker stops being
optional. That's the territory of `2026-08-05-engine-worker-pool.md` — the
clearest candidate to host this rather than a bespoke worker.

## Where it surfaces (kept deliberately minimal)

An on-demand action ("estimate win chances here"), computed once when asked
— not on every ply of a live game (a single batch already costs tens of
seconds to minutes, far more than one move's budget). Output is three
percentages, the interval, and N — plain numbers, no chart, no saved
history. Deliberately not folded into Stockfish's eval bar (itself only a
stretch goal in `2026-08-03-engine-room-design.md`, not confirmed built),
keeping this feature decoupled from that one's fate. Anything beyond this is
out of scope below — the point of this spec is the compute layer under it.

## Verification plan

No automated test suite exists here — every check is a manual action,
following the existing pattern in `app/dev/maia-test/page.tsx` (a `<pre>`
page logging PASS/FAIL lines, a `done` marker at the end) driven by the
already-generic `scripts/cdp-verify.mjs` (`node cdp-verify.mjs <url>
<done-marker> <timeout-ms>`) — no new driver needed, just a new page, e.g.
`app/dev/maia-rollout-test/page.tsx`.

1. **Batching correctness (the sharpest check here).** Run one position
   through `evaluateMaiaBatch` at N=1 and compare to `evaluateMaia` on that
   FEN (allow ordinary floating-point drift across batch sizes — a known
   wasm/BLAS effect, not a red flag alone). Then batch **two distinct
   positions** at N=2 and confirm each row matches evaluating it alone —
   distinct positions matter because identical copies of one position would
   hide a transposed/off-by-one row (every row "should" agree anyway). Same
   caution `scripts/maia-notes.md` applies elsewhere: a wrong implementation
   still looks legal and plausible.
2. **Degenerate check: mate-in-1.** From a constructed mate-in-1 FEN, run
   N=30 rollouts. Expect overwhelming wins for the mating side — a perfect
   30/30 gives Wilson `[88.6%, 100%]` (see Statistics). Read the observed
   rate against Maia's own policy mass on the mating move at T=1 (check via
   `evaluateMaia` directly) rather than assuming exactly 100% — if the model
   itself puts only ~90% of the mass on the mate, occasional misses are
   correct sampling, not a bug. A rate near 50% or near 0% points to a
   perspective/sign bug instead.
3. **Sanity check: correlation with Stockfish, not equality.** Across
   positions spanning a range of Stockfish evals, run N=100 rollouts at a
   fixed Maia tier from each; win probability should move the same direction
   as Stockfish's cp, checked by sign/rank, not numeric match — a tight
   numeric match would be suspicious, since the premise is that these two
   diverge (an easy-to-miss tactic can show a big cp edge while converting
   far less against humans). Needs one prerequisite: `parseSearchDepth` in
   `lib/chess/engines.ts` only extracts `depth` from `info` lines today;
   pulling `score cp \d+` from the same stream (a two-line parser) is outside
   this spec's core scope but required to get numeric cp for the comparison.
4. **Masking check.** Seed one lane of a batch with a mate-in-1/2 (finishes
   fast) alongside long-running lanes. Confirm the finished lane's outcome
   freezes rather than changes, and the still-running lanes match what
   they'd get evaluated alone — no leakage from a finished neighbor.
5. **Interval sanity.** For a few real N/p̂ results, hand-check the reported
   interval against the Wilson formula/table rather than trusting the code —
   catches a swapped z-value or an accidental Wald implementation.

## Risks

- **Batch axis might not be dynamic** — the load-bearing risk. If hardcoded
  to 1, this approach doesn't run at all and needs a different strategy
  (several small sessions, or re-exporting the model), outside this scope.
- **Per-ply batched latency might not beat the floor** — if the backend
  doesn't scale sub-linearly at these sizes, the cost case collapses to
  "same wall clock, fewer lines of scheduling code."
- **Self-play distributional shift — conceptual, not engineering.** Maia
  imitates real human-vs-human games; chaining its own samples back into
  itself as "the opponent" for dozens of plies is a different input
  distribution than training data ever saw. Whether the resulting
  trajectories actually resemble real human games is open and unresolved —
  the single biggest reason to treat these probabilities as informative
  rather than precise.
- **Main-thread jank** if per-ply latency lands high (see Cost model).
- **Value-bootstrap calibration is a guess** (see Termination), worse as
  `truncated/n` grows.
- Low risk, noted for completeness: 50-move/repetition detection is reused
  from chess.js via `describeEnd`, already trusted elsewhere, not reinvented;
  and low-end-device behavior is untested — the numbers above are small in
  absolute terms but unverified outside a normal dev machine.

## Out of scope

- Any UI beyond the minimal on-demand readout — no charts, no saved history,
  no eval-bar integration.
- Batching *different* root positions into one call (this batches N
  rollouts of the *same* root only).
- Adaptive/sequential sampling (stopping early once the interval is "tight
  enough") — N is fixed upfront, no early-stopping rule specified.
- Any change to `getMaiaMove` or the live game loop's behavior.
- Persisting rollout results to KV or the game-history store.
- A WebGPU or multi-threaded onnxruntime-web backend — still single-threaded
  wasm, consistent with the rest of this codebase.
- Tree reuse across moves (no MCTS-style incremental search) — this is flat
  rollout sampling, independently re-run wherever it's asked about.
- Deciding which rating(s) to sample at — taken as a given input (a preset
  tier, or whatever `2026-08-05-bayesian-rating-inference.md` produces);
  this spec only consumes a rating, it doesn't choose one.
