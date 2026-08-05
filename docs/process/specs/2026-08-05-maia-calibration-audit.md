# Maia calibration audit — spec

Checks whether `maia_rapid.onnx`'s move probabilities mean what they say:
when it predicts 30% for a move, do humans at that rating bucket actually
play it about 30% of the time. This is an *evaluation* of a released
model's existing outputs, not a change to it — nothing here trains or
fine-tunes any weight, including in the correction it proposes if the
answer is "no." Written 2026-08-05, after Task 3 (`docs/maia-notes.md`,
`docs/process/reviews/task-03-maia-review.md`) shipped Maia 2 rapid on `/model-1v1` and
`/user-1v1`. `2026-08-05-bayesian-rating-inference.md` already exists and
names this audit as a stated dependency, so it was read in full —
connections appear inline below, not gathered into one section.
`2026-08-05-move-surprisal.md` and `2026-08-05-maia-monte-carlo-rollouts.md`
don't exist yet (checked); mentions of them are inferred from filename and
task description only.

## What "calibrated" means, and what it doesn't

Different questions, scored separately, not folded into one number:
**accuracy** — does `argmax p(m)` match the human's move, binary, already
published (~50% top-1 at best) — versus **calibration** — across all the
times Maia says "30%," is the true rate close to 30%. A model can be
accurate and miscalibrated (right move, wrong confidence) or calibrated and
inaccurate (honestly reports low confidence and is usually wrong anyway).
Accuracy answers "does Maia play like a human"; calibration answers "can
anything built on the number attached to that move trust it."

## Constraints this spec has to respect

No training or fine-tuning, ever (every check here reads existing outputs;
the temperature-scaling remedy below is argued against this exact line);
zero budget (the corpus must be free and license-compatible with bundling a
derived sample — verified below, not assumed); and both engines normally
run client-side, but this audit is not the app itself (see "Where this
runs" for why that's the right call here).

## The data problem

Calibration needs (position, move actually played, player's real rating)
rows from real humans, at some volume. This app doesn't produce that today:

- `lib/games/types.ts`'s `GamePlayer` is `{ type: EngineType; label: string
  }` — no numeric rating field, ever, for any player. A human side is
  always `{ type: "human", label: "You" }`.
- `lib/games/localStore.ts` caps at `MAX_RECORDS = 50`, per-browser
  (`localStorage`), pruned oldest-first — the wrong order of magnitude even
  setting the point above aside.
- Most recorded games are `mode: "model-1v1"` — engine vs. engine, no human
  in the game at all.

Three ways to get real data anyway, weighed below.

### Option A — bundled Lichess sample (recommended)

The [Lichess open database](https://database.lichess.org) publishes monthly
dumps of every rated game on the site. Checked this session, not assumed:

- **License — CC0, verified against the source, quoted exactly:** "Database
  exports are released under the Creative Commons CC0 license... download,
  modify and redistribute them, without asking for permission."
  (`database.lichess.org`, fetched twice.) Covers bundling a *derived*
  sample — FEN/move/rating rows, not raw PGN — in this repo.
- **Ratings confirmed by example header:** `[WhiteElo "2100"]`, `[BlackElo
  "2000"]`. Nuance: Glicko-2 estimates under an "Elo" tag name, not literal
  Elo (Risks).
- **Naming/filtering:** `lichess_db_standard_rated_YYYY-MM.pgn.zst`,
  monthly, zstd-compressed, all speed categories mixed into one file
  (confirmed via search) — one speed category is selected by the `Event`
  tag (`"Rated Rapid game"`), not filename. The shipped weight is literally
  named `maia_rapid.onnx`, so the sample must be filtered to **rapid**
  specifically, or every number here is quietly wrong. Exact monthly size
  for `standard` isn't confirmed (the one figure fetched, ~80–90 MB, was
  the much-lower-volume antichess variant) — doesn't matter, since
  streaming plus an early stop means the full month is never stored.

Build sketch (a script this spec specifies, does not create):

```
scripts/build-maia-calibration-fixture.mjs
  → streams one lichess_db_standard_rated_*.pgn.zst month
  → filters Event contains "Rated Rapid game"
  → parses with chess.js's own loadPgn (the project's one rules authority;
    no second hand-rolled PGN parser)
  → replays plies on a fresh Chess(), recording fen-before-move
  → keeps at most 1-2 plies per game (one long game shouldn't dominate the
    sample — positions inside a game aren't independent draws)
  → stops once 3,000-5,000 rows are collected, discards the rest
  → writes scripts/fixtures/maia-calibration-sample.jsonl
```

Row schema, one JSON object per line:

```json
{"fen": "...", "move": "e2e4", "moverRating": 1486, "opponentRating": 1523}
```

`move` is UCI (`from+to+promotion`), matching `engineMaia.ts`'s own internal
format so scoring never needs a second notation conversion; rating bucket
is computed at analysis time via the already-exported `eloToCategory`, not
baked in, so a bucket-edge change doesn't force regenerating the file.
Size check: ~130 bytes/row × 4,000 rows ≈ 500 KB — two orders of magnitude
under the 93 MB model weight the app already fetches at runtime
(`MAIA_MODEL_SIZE_MB`), well inside the bloat budget `docs/maia-notes.md`
spent real effort protecting elsewhere.

**Connects directly to `bayesian-rating-inference.md`:** that spec's
posterior lives over exactly the 9 named buckets `MAIA_RATING_BUCKETS =
[1100..1900]`, so that's this audit's primary scope too. It also proposes
`evaluateMaiaAt(fen, selfBucket, oppoBucket)` (not yet built), splitting
`elo_self`/`elo_oppo` into independent arguments, and declines to
marginalize `elo_oppo` "unless [this audit] finds it matters enough to
justify 9× the cost." Answerable cheaply: `getMaiaMove` sets `elo_oppo =
elo_self` always, so headline numbers match that, with a second pass using
the PGN's *true* opponent rating as a secondary comparison — barely
differing favours the other spec's cheap default; diverging justifies the
9× cost.

### Option B — the app's own games, rating-labelled by the Bayesian estimator

Rejected as circular, stated plainly: `bayesian-rating-inference.md`'s
estimator is built *on* Maia's move probabilities as a likelihood. Using its
output as the "true rating" label to then audit whether those same
probabilities are calibrated tests the model against its own inference —
any real miscalibration would launder itself into an apparently-good score.
Also the thin corpus above (50-cap, no rating field, mostly
engine-vs-engine). Not used here; if ever cited elsewhere, label it
non-independent.

### Option C — self-consistency (Maia sampling itself)

A pipeline smoke test, not a calibration result. Worth being precise about
why it isn't just "does a weighted-random-choice reproduce its own input
weights" (meaningless): take a few hundred FENs (reuse a subsample of
Option A's fixture), run one forward pass per FEN at each of the 9 buckets,
treat that policy as ground truth, draw simulated "plays" from it in
software (no extra inference), and run those rows through the *exact same*
binning/ECE code real human rows will later see. A correct pipeline must
recover ECE ≈ 0, since the "ground truth" was sampled from the exact thing
being scored — if it doesn't, the bug is in the harness, not in Maia's
honesty about its own confidence. Run this first; trust human-corpus
numbers only after it passes.

**Decision:** Option A is the primary evaluation set. Option C runs first,
as a gate. Option B is excluded, for the circularity reason above.

## Metrics

For position *i*, let *L_i* be its legal moves (`chess.moves({verbose:
true})` — the set `evaluateMaia` already restricts its softmax to), let
*p_i(m)* be Maia's probability for move *m* ∈ *L_i* (already normalized),
and let *y_i* be the move the human actually played.

**Top-1 / top-3 accuracy** — the sanity anchor against the published ~50%
figure (Verification):

```
top1 = (1/N) Σ_i  1[ argmax_{m∈L_i} p_i(m) = y_i ]
top3 = (1/N) Σ_i  1[ y_i ∈ (3 highest-probability moves in L_i) ]
```

**Brier score — two versions, named separately on purpose,** since they
answer different questions:

```
full-distribution:  BS_full   = (1/N) Σ_i Σ_{m∈L_i} (p_i(m) − 1[m=y_i])²
played-move-only:   BS_played = (1/N) Σ_i (1 − p_i(y_i))²
```

`BS_full` is the textbook multiclass score — it also penalizes mass spread
across obviously-wrong moves, and its scale depends on |L_i|, so
cross-position comparisons need that caveat stated alongside the number.
`BS_played` drops that term — simpler, but not "the Brier score" in the
standard sense. Report both, labeled, so neither is mistaken for the other.

**Log loss** — cross-entropy of the played move's probability:

```
LL = (1/N) Σ_i  −ln( p_i(y_i) )
```

No epsilon-clamping needed: `p_i` is a softmax over *L_i* and *y_i* ∈ *L_i*,
so `p_i(y_i)` is a ratio of positive exponentials — never exactly 0.
Reported in nats; match `move-surprisal.md`'s base once it exists rather
than keeping this independent.

**Reliability diagram and ECE.** The literal question — "when Maia says
30%, do humans play that move 30% of the time" — is per-*(position,
candidate move)*, not just per-position, so score every legal move, not
only the top pick: for every pair (i, m) with m ∈ L_i, let *s = p_i(m)* and
*o = 1[m = y_i]*. Pool all pairs across the corpus (roughly 30-40× the row
count, the rough middlegame branching factor) and bin by *s*.

*Binning — equal-count (quantile), not equal-width:* chess policies are
heavily skewed — most legal moves get well under 1% of the mass, a handful
of candidates carry almost everything. Equal-width bins over [0,1] would
dump nearly all pairs into the bottom bin and leave the high-confidence
bins — the ones that matter most — sparse and noisy. Equal-count bins
guarantee every bin has enough pairs for a stable rate, at the cost of
data-dependent edges. Report equal-count as primary; equal-width is cheap
to also compute and more familiar as a picture, but its near-0 bin reads as
overpopulated-by-construction, not as evidence of good calibration there.

```
ECE = Σ_{b=1}^{B}  (n_b / N_pairs) · | acc_b − conf_b |
```

`n_b` = pair count in bin *b*; `conf_b`/`acc_b` = mean predicted probability
/ empirical played-rate in the bin. Also report the classic top-1-only
variant (Guo et al., 2017) — one pair per position, (i, argmax p_i) — the
more standard "is the model's favourite move's confidence trustworthy"
question, narrower than every candidate's. Diagram: probability on x,
empirical frequency on y, *y = x* as perfect calibration, bin counts as a
bar chart underneath so thin-data points are visible as such.

## What a bad result would mean, and the fix

If Maia is systematically over- or under-confident, both sibling specs
inherit it silently:

- **`bayesian-rating-inference`** — an overconfident Maia sharpens
  posteriors faster than the evidence justifies; underconfident, and the
  posterior never sharpens. The MAP bucket likely survives a monotonic
  miscalibration reasonably well, but the reported 80%-coverage credible
  interval would not — it would stop meaning "80%," exactly what that
  spec's own Risks section flags as unverified pending this audit.
- **`move-surprisal`** — its per-move stat is presumably this audit's
  log-loss term computed one row at a time. A temperature bias shifts every
  value consistently; relative comparisons ("more surprising than") likely
  survive since scaling preserves rank order, but a fixed threshold ("flag
  surprisal > X") would over- or under-fire and need re-tuning.

**Remedy: temperature scaling, fit on held-out data, one scalar.** Rescale
the policy logits by a learned constant *T* before the softmax that's
already there:

```
p_i(m; T) = softmax( logits[m] / T )   over m ∈ L_i
T* = argmin_T  (1/|held-out|) Σ −ln p_i(y_i; T)     (held-out log loss)
```

Fit *T* on a held-out split of the same corpus — not the rows the headline
ECE is reported on, or the correction grades itself on the exam it wrote.
Start with one global *T*; check whether a per-bucket *T* differs
meaningfully before adding nine separate scalars.

**This is not training, and it's worth saying precisely why.** Fitting *T*
touches zero model weights — a one-parameter rescale applied to logits
*after* `session.run()` returns, the same category of operation as the
softmax-over-legal-moves step `evaluateMaia` already does, one more scalar
multiplied in first. No gradient flows into the ONNX graph; nothing about
`maia_rapid.onnx` changes on disk or at load time. Worth stating explicitly
because "calibrating a model" sounds adjacent to "training a model," and
this project's hardest constraint is specifically about the latter.

**Integration point, if adopted:** inside `evaluateMaiaAt`, so both this
audit's numbers and `bayesian-rating-inference`'s likelihood inherit the
correction automatically rather than patching two call sites separately —
not built here, just named so whoever lands `evaluateMaiaAt` knows a second
caller wants the hook.

## Where this runs

**A one-off Node script under `scripts/`, not in-app code.** Reasons:

- Nothing about "is Maia calibrated" needs computing while a player looks
  at a board — a research artifact, run once or re-run on change. Contrast
  with `bayesian-rating-inference`, which must run its 9 per-bucket passes
  live in-browser, on the main thread, and worries in its own Cost/Risks
  about contention and concurrency — none of that applies offline.
- **Reuse the pure math, not the browser session.** `onnxruntime-web`
  exists in this app for browser reasons (fetch-with-progress, wasm paths
  under `public/ort/`) a batch pass doesn't need, so `onnxruntime-node`
  (native bindings, same `onnxruntime-common` `Tensor`/`InferenceSession`
  surface) fits a script better. `mirrorFen`, `mirrorMove`, `boardToTensor`,
  `eloToCategory` have no browser dependency — import them directly.
  `evaluateMaiaAt`, once it exists, is shaped for the browser's singleton
  session and can't literally be called from Node, but this script should
  share its exact pure encode → softmax logic underneath — two thin
  runtime shims over one shared core, not a third implementation. This
  project already paid once for two encoders quietly disagreeing
  (`docs/process/reviews/task-03-maia-review.md`, Q3's en-passant finding); a fourth copy
  of this math is how that repeats.
- Script dependencies (`onnxruntime-node`, a zstd/PGN helper if needed) are
  dev-only tooling, never in the Vercel build or client bundle, so they
  don't compete with the `public/ort`/`public/maia` budget discipline. The
  93 MB weight still has to come from somewhere — fetch it from the same
  mirror `engineMaia.ts` uses, cached to local disk between runs, not
  re-committed.

**Does any of this surface in the app?** No. Output is a report a human
reads, written to disk as JSON so a chart could be built later, not this
spec's job. If a temperature correction is adopted, *T* landing inside
`evaluateMaiaAt` is the one plausible way this touches the running app — a
follow-up, not built here.

## Cost

Per-row cost is one forward pass: **35 ms** per `docs/maia-notes.md`'s
spike, **47–55 ms** per `docs/process/reviews/task-03-maia-review.md`'s re-measurement on
different hardware — matching the citation `bayesian-rating-inference.md`
already uses. Call it ~50 ms as the planning number, for consistency.

- **Main pass:** 3,000–5,000 fixture rows × ~50 ms ≈ **2.5–4 minutes**,
  sequential, single-threaded.
- **Self-consistency gate:** ~300–500 reused positions × 9 buckets × ~50 ms
  ≈ **2.5–4 minutes** too — comparable despite needing no human data,
  since it's still one forward pass per (position, bucket) pair.
- **Temperature fit:** free — cache each row's raw per-legal-move logits
  during the one pass that already happens; fitting *T* afterward is a 1-D
  search over cached numbers, not a model re-run per candidate *T*.

**If `2026-08-05-maia-monte-carlo-rollouts.md`'s batching lands:**
`evaluateMaia` today hardcodes batch size 1 (`new ort.Tensor("float32",
boardToTensor(encodedFen), [1, 18, 8, 8])`), so every row pays full
session-call overhead independently; a batched call would speed this pass
up by roughly the batch factor. **Unverified** whether the real speedup
approaches that: this app runs `onnxruntime-web` single-threaded
(`numThreads = 1`, to avoid COOP/COEP headers), and CPU/wasm backends don't
always parallelize a batch dimension as cleanly as a GPU would —
`bayesian-rating-inference.md` names the identical caveat about its own 9
per-ply calls. Worth one shared check once that spec exists.

## Verification plan

No automated test suite, per this project's norm (design doc's Testing
section: manual verification per phase). The checks below prove the
harness itself isn't lying before trusting what it says about Maia.

1. **Perfectly-calibrated synthetic predictor → ECE ≈ 0.** (predicted
   probability, outcome) pairs where the outcome is literally drawn at the
   stated probability — nothing to do with chess. Run through the exact
   binning/ECE code; expect ECE near zero, shrinking as sample size grows
   (check two sizes, don't assert "≈0" once).
2. **Deliberately over- and under-confident synthetic predictors → both
   visibly worse.** Same generator, probabilities pushed toward 0/1
   (overconfident) or flattened toward uniform (underconfident) — both must
   score markedly worse than check 1 on ECE, log loss, and Brier, confirming
   the harness penalizes both directions, not just one.
3. **Maia self-consistency pass → ECE ≈ 0 against its own samples.** The
   real pipeline, not synthetic numbers (Option C) — the gate before
   touching the human corpus.
4. **Hand spot-check ~10 fixture rows.** Replay the stored FEN in `chess.js`
   by hand, confirm the move is legal and matches the raw PGN at that ply —
   catches an off-by-one-ply bug before it contaminates thousands of rows,
   the same discipline `docs/process/reviews/task-03-maia-review.md` used throughout.
5. **Sanity anchor: top-1 accuracy should land near the published ~50%.**
   Not pass/fail, but if wildly off (5%, 95%), suspect the fixture pipeline
   before concluding Maia differs from its published numbers.

Existing prior art, not redone here: Task 3's review already ran a
canonical-parity check of the encoder — CSSLab's *training-side*
preprocessing, ported to Python, run against the same released
`maia_rapid.onnx`, matching the browser pipeline "to 0.1 percentage points
on every test position" (`docs/process/reviews/task-03-maia-review.md`, Q3). That transfers
here *only if* the Node script imports `engineMaia.ts`'s encoder rather
than reimplementing it. That Python script is not a committed file in this
repo, worth knowing so nobody goes looking — it's documented in that
review and in PR #12's discussion, not checked in anywhere.

## Risks

- **Corpus/training mismatch, and selection effects.** Lichess rapid games
  — same site, same speed category — aren't necessarily the same sample
  CSSLab trained with (date range, region, filtering unknown), and rapid
  players are a self-selected online population, not a random sample of
  human chess players (the published ~50% figure presumably carries the
  same caveat). This audit answers "calibrated against a same-shaped
  external sample," not "against its own training data."
- **Rating label noise.** WhiteElo/BlackElo are Glicko-2 point estimates
  with no rating deviation in the standard export. A human near a bucket
  boundary (1149 vs. 1151) is a coin flip from a different label, smearing
  the diagram independent of anything Maia gets wrong.
- **The `elo_oppo` convention is a real choice, not a footnote** — state
  which one (matched vs. true opponent rating) produced the headline result.
- **Thin high-confidence bins.** Maia rarely puts more than ~70-80% on a
  single legal move, so the bins that matter most may still be sparsest.
  Mitigated by equal-count binning and reporting bin populations, not
  hiding them.
- **Data engineering, not inference time, is most of the effort.** Node's
  built-in `zlib.zstdDecompress` only landed in **23.8.0** (this repo's
  `@types/node` is `^20`) and this dev machine is Windows, so prefer a
  WASM/pure-JS zstd decompressor over a native-binding package if one is
  added — native builds are the likelier install failure here.
- **Unmeasured interaction with Maia's opening prior.** That knight-heavy
  prior (`docs/process/reviews/task-03-maia-review.md`, Q3) "looks constant across
  ratings... not measured either way" per `bayesian-rating-inference.md`'s
  Risks — a per-bucket ECE breakdown would be one of the few ways to check,
  optional here.

## Out of scope

- Landing the temperature correction inside `engineMaia.ts` or
  `evaluateMaiaAt` — this spec defines the remedy and how to validate it,
  not a change to production inference code.
- Auditing Stockfish analogously — `UCI_Elo` doesn't emit a probability
  distribution, so there's nothing to calibrate in this sense.
- Reproducing CSSLab's own evaluation methodology in full; the published
  ~50% figure is used only as a sanity anchor (Verification, check 5).
- Any `elo_self`/`elo_oppo` interaction beyond the one headline convention
  plus the one secondary comparison (Risks).
- Maia 3, or any blitz/bullet/classical Maia variant, or any weight file
  other than the one already shipped (`maia_rapid.onnx`).
- Any new route, component, or persisted-storage schema change.
- Any other item still open in `docs/maia-notes.md` (missing `LICENSE`
  file, the IndexedDB model cache, the unused `logits_side_info` head) —
  unrelated to whether the policy head's probabilities are calibrated.

## Cross-references

- **`2026-08-05-bayesian-rating-inference.md`** — exists, read in full; the
  load-bearing connections (9-bucket scope, the `evaluateMaiaAt` split, the
  `elo_oppo` marginalization question, what a bad ECE means for its
  credible interval) are made inline above — see "The data problem," "What
  a bad result would mean," and "Cost" — rather than repeated here.
- **`2026-08-05-move-surprisal.md`** — doesn't exist yet. Presumed to
  report −log p(move played) per move, this audit's log-loss term
  computed one row at a time; a temperature correction would rescale it
  directly, and should match its log base (Metrics).
- **`2026-08-05-maia-monte-carlo-rollouts.md`** — doesn't exist yet.
  Referenced only for its presumed batching (Cost), a benefit shared with
  `bayesian-rating-inference.md`, whose real speedup here neither doc has
  verified.
