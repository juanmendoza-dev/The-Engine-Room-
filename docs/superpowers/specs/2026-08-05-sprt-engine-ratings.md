# SPRT Engine Ratings — Spec

Task 2's own verification notes end with an admission:

> Depth does not vary with ELO (13 at both 1320 and 2800)... So this spike
> proves the options are accepted and the engine searches; it does **not**
> prove the ELO settings change playing strength. That only becomes
> measurable in Task 6, over several complete games between a low and a high
> preset, scored by results.

Task 6 shipped the game loop; nobody has scored the games. The Stockfish
dropdowns say 1320/1800/2800 on faith in a UCI option string, and Maia's
1100/1500/1900 have the same problem one level removed — `scripts/
maia-notes.md`'s own rating-responsiveness check found the top move
unchanged across all three ratings ("proves the input is wired... not that
it produces a large strength difference"). This spec is the measurement: a
rating fit over accumulated results, plus a sequential test (SPRT) that
knows when it's seen enough games to stop guessing.

Sibling specs, none of which existed in the repo as of this writing (cited
for what this spec needs from them, not their contents): `2026-08-05-engine-
worker-pool.md` (parallel matches, the only way this finishes in reasonable
time), `2026-08-05-opening-trie.md` (the randomized opening book below
depends on it), `2026-08-05-policy-mixture-engine.md` (a future engine that
plugs into this machinery unchanged).

## Goals / constraints

- Measure empirical strength, with uncertainty, of every preset in
  `ALL_ENGINE_PRESETS` (currently 6: Stockfish 1320/1800/2800, Maia
  1100/1500/1900) from game results, not the dropdown label.
- Decide "is A actually stronger than B, and by how much" via a sequential
  test that stops once the evidence is in, fishtest-style, not a fixed game
  count picked by guesswork.
- Reuse `runModelGame` (`lib/chess/gameLoop.ts`) for every game. No second
  game loop.
- Zero budget: no paid compute, runs on whatever machine is open.
- Doesn't touch model weights or `UCI_Elo`/rating-tier values — this
  measures presets as configured, it doesn't retune them. Retuning based on
  the results would be a heuristic-settings layer at most (design doc's
  constraint), and is out of scope here.
- Doesn't change what `getMoveFor`/`getStockfishMove`/`getMaiaMove` return to
  the live app. New files, or additive backward-compatible options on
  existing ones (one such change is needed — Interfaces).

## The determinism problem — read this first

Both engines are close to deterministic at fixed settings, which is why
"play preset A vs B 100 times and count wins" gives a sample size of one
wearing a hundred costumes. Has to be fixed before anything below matters.

**Maia is exactly deterministic.** `getMaiaMove` (`lib/chess/engineMaia.ts`)
takes `policy[0]`, the argmax of a softmax over legal moves — a pure
function of `(fen, ratingTier)`. Same inputs, bit-identical output, forever.

**Stockfish is not exact, but its variance is small and uncontrolled.**
Task 2's own Step 6 output:

```
elo 1320  run 1  depth 13    played a3   507ms
elo 1320  run 2  depth 13    played a3   506ms
elo 2800  run 1  depth 13    played Nc3  508ms
elo 2800  run 2  depth 13    played d4   508ms
```

Same position and `UCI_Elo`, two runs each. At 1320 both runs agreed (the
strength-limiter's weighted pick dominates); at 2800 they didn't (`Nc3` vs
`d4`) — `go movetime 500` is a wall-clock search, so timing jitter can flip a
close call. Real variance, but accidental — it can't be sized, seeded, or
relied on to decorrelate games, and most early moves (where eval gaps are
large and stable) will still repeat far more often than not.

Net: N replayed games from the fixed start position gives an effective
sample size near 1 (Maia involved) or "some small, unknown number"
(Stockfish only) — never N.

**Fix: a randomized opening book replaces engine choice for the first K
plies.** Before either engine is consulted, the runner applies K prescribed
SAN moves from a small book (picked uniformly per game) via `chess.js`'s own
`.move()` — same legality authority as everywhere else in this app, so a bad
book entry throws immediately. Only after the book is exhausted does
`getMoveFor` run. Neither engine's own logic changes: a deterministic engine
still produces a distinct game per distinct opening, because the *positions*
differ, not because the engine got randomized.

How much book: **at least ~16 structurally distinct lines (different first
moves/pawn structures, not move-order permutations), each 4–8 plies deep.**
Not a proven bound — 2–4 plies among genuinely different first moves
(`e4`/`d4`/`Nf3`/`c4`, not `e4` vs `e3`) already changes the pawn structure
enough to stop transposition, which is the real risk, not raw ply count.
Size matters because a repeated line is still a repeated game: at ~22 games
(the sanity-check case below) even 8 entries keeps expected repeats under 3;
at ~320 games (the precision case) 16 entries averages ~20 repeats/line —
tolerable, but the number to watch if the real book is smaller. This is an
estimate; see Verification for the real-game spot check that would confirm
it. The book's actual structure is `2026-08-05-opening-trie.md`'s job; this
spec only requires the size/depth minimums above and otherwise treats it as
an opaque `OpeningLine[]`.

**Escalation, not default: policy-temperature sampling for Maia.**
`evaluateMaia` already returns the full sorted `policy` list, so categorical
sampling from it (temperature 1, no argmax) instead of taking `policy[0]` is
a few lines in `lib/analysis/`, not a change to `engineMaia.ts`. Not the
default because the deployed app always takes argmax, and a run that
samples measures the strength of Maia's whole distribution — sometimes its
2nd or 3rd choice — not what a user actually watches. Use only if the book
alone doesn't decorrelate enough in practice, and only post-book, never
inside it.

## Rating math

### Bradley-Terry with a Davidson draw term

Preset `i` has strength `β_i` (Elo); `π_i = 10^(β_i/400)`. No-draw win
probability `π_i/(π_i+π_j)` — the usual Elo expected score
`1/(1+10^(-(β_i-β_j)/400))`.

Draws aren't rare here. Two ways to handle them, per Davidson (1970), *"On
extending the Bradley-Terry model to accommodate ties in paired
comparisons"*:

**Davidson extension** (recommended) — one shared tie parameter `γ≥0`:

```
P(i beats j) = π_i / (π_i + π_j + γ·√(π_i·π_j))
P(draw)      = γ·√(π_i·π_j) / (π_i + π_j + γ·√(π_i·π_j))
P(j beats i) = π_j / (π_i + π_j + γ·√(π_i·π_j))
```

`γ=0` recovers plain BT. Both the rating fit and the SPRT below use this one
model, `γ` fit once as a nuisance parameter from pooled data — matching
fishtest's own stated approach ("unknown parameters... replaced by their
maximum likelihood estimates").

**Half-wins, the cheap alternative:** score each draw 0.5/0.5 and fit
ordinary no-draw BT on the fractional wins. Stated bias, worked through the
numbers: at a true 200-Elo gap and `γ=0.5`, Davidson gives expected score
0.714, not the pure-logistic 0.760. A half-win fit forced to explain 0.714
under the no-draw curve backs out `δ̂≈159`, not 200 — a systematic
understatement that grows with the draw rate, because half-win scoring can't
tell "many close draws" (weak evidence) from the same score split entirely
between decisive wins/losses (strong evidence). Fine as a fast first pass or
cross-check, not as the number that ships.

### Anchoring

`π_i` only ever appears as a ratio, so the model is identified only up to a
constant on `β`. Fit unconstrained and the *relative* gaps are good but the
zero point is arbitrary. Fix: anchor one preset — this spec anchors
`"Stockfish 1800"` at `elo=1800` by definition (the mid preset, away from
either clamp), not a claim it's independently verified against any external
human pool. Relative gaps are the honest deliverable; absolute numbers are
only as good as the anchor, and there's no outside calibration to check it
against.

**Ford's condition** (1957): the MLE needs a connected "who played whom"
graph and no preset sweeping 100% of its games. Concretely: Stockfish and
Maia only share one scale because Model 1v1 lets them play each other — the
schedule must include cross-engine pairings, or the two families become
disconnected islands with nothing to compare. The fit should detect a
diverging/NaN iterate and report "insufficient connectivity," not silently
emit a number.

### Fitting it

Classical MM iteration for plain BT (Zermelo 1929; Hunter 2004, *"MM
algorithms for generalized Bradley-Terry models,"* which also covers the
Davidson generalization this spec needs), given wins `w_i` and games-played
`n_ij`:

```
π_i ← w_i / Σ_{j≠i} [ n_ij / (π_i + π_j) ]
```

Repeat for every `i`, renormalizing (anchor fixed) each round, until stable
— monotonic, no step-size tuning. The Davidson-extended joint update (`π`'s
and `γ` together) is more involved; see Hunter (2004) rather than a
hand-derivation here. Practical recommendation for `ratingBT.ts`: with only
~6 presets (5 free elos + `γ`), a coordinate-wise Newton step
(`∂logL/∂β_i=0`, one parameter at a time, looped to convergence) hand-codes
without a linear-algebra dependency and converges faster than MM —
implementing both and checking agreement is a cheap independent-
implementation cross-check, same spirit as this codebase validating Maia's
encoder against hand-computed ground truth.

### Glicko-2 — secondary, optional

Full derivation cited precisely rather than reproduced here: Glickman,
*"Example of the Glicko-2 system,"* glicko.net/glicko/glicko2.pdf. Shape of
it: each preset carries rating `r`, deviation `RD`, volatility `σ`; per
rating period, `RD` and `σ` update from that period's game scores via an
estimated variance `v`, an improvement estimate `Δ`, and an iterative
(Illinois-algorithm) solve for the new `σ` bounded by a system constant `τ`
(Glickman suggests 0.3–1.2) — see the cited paper for the exact step-by-step
formulas, since reproducing that derivation isn't worth the space next to
the fully-derived BT model above.

Caveat: built for sparse, asynchronous ladders with skill that drifts over
time. Our presets are static and the schedule dense — closer to the
classical paired-comparison design BT is for, so volatility will just
converge to its floor and sit there. Offered because a single RD number
("Stockfish 1320: 1290±45") is friendlier in a UI than a BT covariance
matrix — a presentation convenience, not the primary fit.

## SPRT

### H0, H1, the LLR, the stopping bounds

Standard Wald (1945) SPRT. `H0: δ=elo0`, `H1: δ=elo1`; each implies a
`(p_win,p_draw,p_loss)` triple via the same Davidson model above (same `γ` —
rating fit and SPRT share one model, not two). Per-game LLR increment, for
whichever outcome `R` landed:

```
Z = ln(P_H1(R)/P_H0(R))          Λ_n = Σ Z_i
```

Choose Type-I error `α`, Type-II error `β`:

```
A = ln((1-β)/α)   — cross this: accept H1
B = ln(β/(1-α))   — cross this: accept H0
```

Continue while `B<Λ_n<A`. This is the textbook Wald derivation, not fishtest's
internal GSPRT/pentanomial formula — its wiki points to external PDFs for
that rather than publishing it inline, so this isn't claimed as a
reverse-engineering of it, just the same method (sequential testing against
an explicit elo0/elo1 pair) worked through a model this spec can verify
(see Verification).

### Trinomial, not pentanomial — for now

fishtest's real refinement pairs two games per opening (colors swapped),
scoring the pair as one of 5 outcomes to cancel opening-driven variance. This
spec uses the simpler **trinomial** model (each game scored independently),
fully derived above and sufficient here. One cheap piece of the idea comes
free anyway: the runner plays each sampled opening with colors swapped too,
canceling first-move/color bias without adopting fishtest's paired LLR.
Genuine pentanomial scoring is a future upgrade (Risks), not built now.

### Worked example: games to a decision

Illustrative `γ=0.5` (a guess at sub-2800 draw rates, not measured),
`α=β=0.05` (standard, matching fishtest/cutechess-cli practice): `A=ln(19)
≈2.944`, `B≈-2.944`. Wald's expected-N approximation: `E[N|H1]≈[(1-β)A+βB]/
E_1[Z]`, `E[N|H0]≈[αA+(1-α)B]/E_0[Z]`, where `E_1[Z]`/`E_0[Z]` is the
per-game expected LLR increment under each hypothesis (KL divergence, each
direction):

| Question | elo0 | elo1 | E₁[Z] (nats/game) | Expected games |
| --- | --- | --- | --- | --- |
| Is the label directionally real? | 0 | 200 | 0.119 | **≈20–25** |
| How much does each step add? | 0 | 50 | 0.0082 | **≈320** |

The ~14x jump in games for a 4x smaller gap is in the expected ballpark (KL
divergence scales roughly quadratically in a small gap, which would predict
16x — close enough given this isn't a pure quadratic once draws are in the
model) — precision is expensive, sanity-checking is cheap. Both are expectations (ignoring boundary overshoot); a hard
`maxGames` cap alongside the LLR bounds is still worth keeping, same as
fishtest does.

## Honest wall-clock accounting

At `MOVE_TIME_MS=500` and ~70 plies/game, one Stockfish-vs-Stockfish game is
~35s of thinking (matches the codebase's own "~500ms×~80 plies ≈40s").
Maia answers in ~35ms regardless:

| Pairing | ms/ply | s/game | 22 games | 320 games |
| --- | --- | --- | --- | --- |
| Stockfish vs Stockfish | ~500 both | ~35s | ~13 min | ~3.1 hr |
| Maia vs Maia | ~35 both | ~2.5s | ~1 min | ~13 min |
| Stockfish vs Maia | ~500/~35 | ~19s | ~7 min | ~1.7 hr |

Verdict: a wide-gap sanity check on any Maia-involved pairing is trivially
live-demoable, and on Stockfish-vs-Stockfish (~13 min) it can at least be
started live. A narrow-gap precision run on Stockfish-vs-Stockfish (~3 hr,
serial) is neither — precompute and ship a fixture, or background it.
Multiply by up to 15 (unordered pairings across 6 presets) for a full sweep.

**Parallelism is a hard dependency past the cheap case, and doesn't exist
today.** `engineStockfish.ts` is one shared Worker behind a
promise-serialized queue by design — two concurrent games in one page
wouldn't speed anything up, just interleave onto the same worker. Real
concurrency needs multiple browser contexts (crude, available today: several
headless tabs each running a disjoint slice, merged afterward, since SPRT/BT
fitting tolerates a pooled batch even though the stopping decision is meant
to run online) or `2026-08-05-engine-worker-pool.md`'s actual fix.
`matchRunner.ts` plays one pairing sequentially and depends on that spec (or
tab-pooling) for anything past the wide-gap case.

**What movetime reduction buys, and costs:** two "make it faster" levers,
one free. `moveDelayMs` (pause *between* moves, for human watchability) can
drop to ~0 for headless runs at zero strength cost — nobody's watching.
Stockfish's own `movetime` (`MOVE_TIME_MS=500`) is not free: Task 2 found
search depth constant across ELO (13 at both 1320 and 2800), so cutting it
for speed changes how much tree gets searched before the strength limiter
picks a candidate — a preset calibrated at 50ms measures a *different*
engine than the one deployed at 500ms. A published rating has to be measured
at the app's real movetime; this lever isn't available, however tempting the
10x looks.

## Where results live

Not `lib/games/store.ts`: no room in `GameRecord` for rating/SPRT metadata,
a 50-record cap, and per-browser rather than committed/diffable. These also
aren't user game records — nobody played them. Instead, a checked-in fixture
under `lib/analysis/fixtures/`:
- `games-log.jsonl` — one JSON object per completed game (pairing, opening
  id, result, full SAN list, timestamp). Newline-delimited so each new game
  is a pure append (small diffs), not a rewrite of a growing array.
- `ratings.json` — derived output: fitted BT elo + stderr per preset, fitted
  `γ`, and each SPRT run's terminal state (decision, final LLR, game count).
  Regenerable from `games-log.jsonl` at any time — a cache, not a second
  source of truth.

Both plain JSON/JSONL text; no `.gitattributes` entry needed (that file
covers actual binaries — wasm/onnx/nnue — not these).

## Interfaces

```
lib/analysis/
  types.ts           — OpeningLine, MatchGameResult, SprtConfig, SprtState,
                        RatingEstimate. No runtime dependency.
  eloModel.ts        — pure: davidsonProbs(delta, gamma) -> {pWin,pDraw,pLoss},
                        shared by ratingBT.ts and sprt.ts
  ratingBT.ts        — pure: fitBradleyTerryDavidson(games, presetIds,
                        anchorPresetId, anchorElo) -> {ratings, drawParam,
                        converged, iterations}
  ratingGlicko2.ts   — pure: updateGlicko2(current, games[], tau?) -> Glicko2Rating
  sprt.ts            — pure: createSprt(config) -> SprtState;
                        recordGame(state, outcome) -> SprtState
  openingBook.ts     — placeholder OpeningLine[] + uniform pick, pending
                        2026-08-05-opening-trie.md's real structure
  matchRunner.ts     — BROWSER ONLY: runSprtMatch(config) ->
                        {games, finalSprt, ratings}
  fixtures/games-log.jsonl, ratings.json

scripts/
  sprt-run.mjs              — Node CDP driver, zero-dependency, same pattern
                               as cdp-model-1v1.mjs: URL + CDP port + match
                               config as argv, polls a headless Chrome
                               already running with --remote-debugging-port,
                               pulls final JSON via Runtime.evaluate, writes
                               it into lib/analysis/fixtures/
  verify-analysis-math.mjs — pure Node, no Chrome, no engines — Verification

app/dev/match-runner/page.tsx — new scratch page, same family as
  app/dev/{stockfish,maia}-test and fx-lab: reads config from the URL, runs
  matchRunner.ts, writes progress/result JSON into the DOM for the CDP
  script to poll, same pattern cdp-model-1v1.mjs uses today.
```

Three things worth knowing before building from the tree above:

- **Everything except `matchRunner.ts` is pure math, runnable under plain
  Node** — no `window`/Worker dependency, which is what makes
  `verify-analysis-math.mjs` possible without Chrome. "A Node-side runner"
  can't mean "a plain script plays the games": `engineStockfish.ts` needs a
  real `Worker`, and `engineMaia.ts` throws if `window` is undefined
  (possibly a simplification, not a hard wall — `onnxruntime-web` can
  sometimes run under plain Node — but this spec takes the guard as given).
  So `matchRunner.ts` runs inside a real browser context, and
  `sprt-run.mjs` orchestrates (navigate, poll, collect) rather than plays,
  matching the split `cdp-verify.mjs`/`cdp-model-1v1.mjs` already use.
- **One additive change to an existing file is required.** `runModelGame`
  hardcodes `new Chess()` — no way to hand it a starting position. Fix:
  optional `startFen?: string` on `RunModelGameOptions` (default: standard
  start), one line changed to `new Chess(startFen)` — backward-compatible,
  existing callers pass no such option. `matchRunner.ts` replays the book's
  SAN on a scratch `Chess()` to get that FEN, then concatenates the book
  prefix with `outcome.moves` itself before writing to `games-log.jsonl`
  (`runModelGame`'s own history only covers plies after `startFen`). It
  passes `moveDelayMs: 0`, forwards `signal`, and catches
  `GameAbortedError` per `gameLoop.ts`'s documented convention to return
  partial results rather than throwing the match away.
- **A preset's `label` doubles as its id — a small, real gap.**
  `EngineConfig` has no dedicated identifier; adding one is a wider change
  than this spec wants to force through `lib/chess/types.ts`, so `label` is
  the key for now (relabeling risk noted in Risks).

## Error handling

- **Engine failure mid-match** — don't swallow this the way `saveGame`
  swallows a KV failure; a silently-broken engine risks a quietly-wrong
  rating. Abort the current match, keep completed games (both SPRT and BT
  tolerate partial series), mark the fixture run incomplete.
- **Disconnected graph or a 100%-swept preset** (Ford's condition) — detect a
  diverging/NaN iterate, report "insufficient data to rate preset X," not a
  bogus ±∞.
- **Aborted match** — catch `GameAbortedError`, return the partial result,
  per `gameLoop.ts`'s documented convention.
- **Malformed book entry** — applied through `chess.js`'s `.move()`, so a bad
  SAN throws immediately; a book bug to fix, not a runtime condition.
- **Degenerate probabilities** (e.g. `γ=0` collapsing a draw probability to
  0) — guard the LLR accumulator against `ln(0)` poisoning the running sum.

## Verification plan

No automated suite, per project convention — a check with a known answer,
run once, read by a human. `scripts/verify-analysis-math.mjs`, pure Node, no
engines, no Chrome:

1. Fix a true `(δ_true, γ_true)` (e.g. 150, 0.45), derive exact
   `(p_win,p_draw,p_loss)` via `eloModel.ts`, draw synthetic outcomes with a
   small seeded PRNG (~5 lines, no package needed).
2. **The real check: error rates across many series, not one series'
   stopping point.** Repeat ~200 times under `δ_true=elo1`, confirm `sprt.ts`
   accepts H1 close to `(1-β)` of the time; repeat under `δ_true=elo0`,
   confirm it accepts H0 close to `(1-α)` of the time. Secondary sanity
   metric: average stopping count within ~3x of the `E[N]` formula.
3. Feed the same stream into `ratingBT.ts`; confirm fitted `δ̂`/`γ̂` converge
   toward the true values as games accumulate (tolerance stated at N=2000).
4. Same for `ratingGlicko2.ts` if built, noting the volatility caveat rather
   than treating it as a bug.
5. Print PASS/FAIL lines a human reads — no assertion framework, matching how
   Tasks 2 and 3 verified themselves.

Supplementary, real-games-only, not required for "done": once real matches
run, spot-check the book's collision rate (how many of N games share an
identical sequence beyond the book) against the ply-count estimate above,
which is reasoned, not measured.

## Risks

- Stockfish's true repeat-rate at scale is unquantified (Task 2 gave exactly
  two data points). The book doesn't rely on Stockfish's own variance, but
  it's worth confirming once real games run, especially at low Elo where
  Task 2 saw more determinism.
- `label`-as-id means renaming a preset silently orphans its history — cheap
  to fix later (a real `id` on `EngineConfig`) if it bites.
- Point estimates from the tens-of-games regime this project will actually
  reach carry real uncertainty — both BT's and Glicko-2's asymptotic errors
  are weakest exactly there. Report intervals, not bare numbers.
- Maia's cold-load cost (73–261s on production, per `docs/deployment.md`)
  dominates the first game of any Maia series against a cold tab; the
  module-level singleton means it's paid once per tab, not once per game.
- No parallelism exists today — blocked on `2026-08-05-engine-worker-pool.md`
  (or the multi-tab workaround) for anything past the cheap sanity case.
- Genuine pentanomial scoring is fishtest's real refinement, not built here;
  trinomial-plus-color-pairing is a deliberately smaller step.

## Out of scope

- Surfacing empirical ratings in the live app's UI — this spec only produces
  the fixture.
- Any change to `getMaiaMove`'s/`getStockfishMove`'s default, deployed
  behavior — sampling and `moveDelayMs:0` live only inside `lib/analysis/`.
- Retuning `UCI_Elo`/rating-tier values based on results — a measurement
  tool, not a self-tuning one; that would brush close to the
  no-training/fine-tuning constraint even scoped to settings, not weights.
- A full pentanomial LLR implementation.
- Scheduling policy for the full 15-pairing roster beyond "one pairing per
  `matchRunner.ts` call" — order, and guaranteeing cross-engine coverage for
  Ford's condition, is a thin loop left unchoreographed.
- CI-gating anything on rating drift — no CI budget or engine-versioning
  story here, and it isn't the question being asked.
