# Maia calibration audit

Does `maia_rapid.onnx` mean what it says? When it puts 30% on a move, do humans
in that rating bucket really play that move about 30% of the time?

That is a different question from the one Task 3 answered. Task 3 established
that Maia's encoder is correct and that its *chosen* move is a plausible human
move. This asks whether the **number attached** to a move can be believed — which
matters because two shipped features read that number rather than the move:

- **Task 13's live rating estimate** uses Maia's policy as a likelihood. An
  overconfident Maia would sharpen its posterior faster than the evidence
  justifies, and the "80% credible interval" the readout draws would stop meaning
  80%. That spec's own Risks section names this audit as the thing that would
  tell it.
- **Task 14's rollouts** sample from the policy at temperature 1. If the policy
  is systematically too sharp, every rollout is drawn from a more deterministic
  player than the one being modelled.

Spec: [`specs/2026-08-05-maia-calibration-audit.md`](specs/2026-08-05-maia-calibration-audit.md).
Built as Task 17, the fifth and last of the 2026-08-05 stretch specs.

**None of this runs in the app.** It's four offline Node scripts and a committed
data sample. Nothing was added to a route, a component, or the client bundle.

## Accuracy and calibration are not the same thing

Worth pinning down before any number below, because the two get quoted
interchangeably and this audit reports both:

| | question | this audit's metric |
| --- | --- | --- |
| **accuracy** | is Maia's top move the move the human played? | top-1 / top-3 |
| **calibration** | across every time Maia said "30%", was it right ~30% of the time? | ECE, reliability diagram |

A model can be accurate and badly calibrated (picks the right move, lies about
how sure it is) or calibrated and inaccurate (honestly reports low confidence and
is usually wrong). CSSLab publish ~50% top-1 for Maia; nobody publishes the
second number, which is why this exists.

## The answer

**Maia's probabilities are broadly trustworthy, and mildly overconfident about
its own favourite move.** 3,015 in-scope rows, `elo_oppo = elo_self` (the
convention `getMaiaMove` uses on the gameplay path), 2026-08-05:

| | |
| --- | --- |
| top-1 accuracy | **50.0%** (top-3 77.0%) |
| log loss | 1.5728 nats |
| Brier, full distribution | 0.6399 (mean 30.5 legal moves — the scale depends on that) |
| Brier, played move only | 0.4819 |
| **ECE, all (position, move) pairs** | **0.00278** equal-count / 0.00272 equal-width |
| **ECE, top-1 only** (Guo et al.) | **0.03596** |
| fitted temperature | **T = 1.129** |

Top-1 landing on 50.0% against CSSLab's published ~50% is the sanity anchor, and
it lands exactly.

### The two ECEs disagree by 13×, and the smaller one is the misleading one

This is the finding, and it is why the spec was right to demand both numbers.

Pooled over every (position, legal move) pair, ECE is 0.0028 — near perfect. But
about 90% of those pairs are moves carrying well under 1% of the mass, where
"predicted 0.3%, observed 0.3%" is easy and uninformative. Restrict to one pair
per position at the model's own top move and ECE is **0.036**, and the shape is
not noise:

```
  bin range         n     conf     acc      gap
  0.101-0.262     301   0.2169   0.2159   -0.0010
  0.263-0.316     302   0.2923   0.2384   -0.0539
  0.316-0.366     301   0.3398   0.3223   -0.0176
  0.366-0.426     302   0.3948   0.3841   -0.0107
  0.426-0.487     301   0.4560   0.3953   -0.0607
  0.488-0.561     302   0.5219   0.5000   -0.0219
  0.562-0.659     301   0.6080   0.5748   -0.0333
  0.660-0.770     302   0.7119   0.6755   -0.0364
  0.771-0.917     301   0.8417   0.7342   -0.1075
  0.917-1.000     302   0.9736   0.9570   -0.0167
```

**Ten bins out of ten have a negative gap.** Random error would flip sign about
half the time; a consistent direction is a bias. Maia's top move comes in below
the confidence it was quoted at, everywhere on the scale, and worst where it
matters most — when it says 84%, humans play that move 73% of the time.

Independently fitted, held-out temperature agrees: **T = 1.129 > 1** means the
logits want flattening, which is the same statement arrived at from the other
direction. Applying it cuts held-out ECE from 0.00231 to **0.00089** and log loss
from 1.5575 to 1.5545, and — as it must, since a temperature cannot reorder a
distribution — leaves accuracy at 50.5% untouched.

### `elo_oppo` does not matter, so don't pay 9× for it

`bayesian-rating-inference.md` left open whether its likelihood should
marginalise over the opponent's rating bucket or just fix it to a default, and
said this audit should decide. Scoring the whole corpus twice — once with
`elo_oppo = elo_self`, once with the PGN's **true** opponent rating — differs by
**0.00116 nats** of log loss (1.5728 vs 1.5740) and 0.2 points of top-1.

That is negligible. **Fixing `elo_oppo` to a default is safe**; marginalising it
would cost 9× the forward passes to buy nothing measurable.

### What it means for the live rating readout

Task 13's readout is the feature with the most at stake here, since its own Risks
section flagged this audit as the thing that would tell it whether its 80%
credible interval means 80%.

The honest read: **probably fine, and not measured.** The miscalibration found is
mild (T = 1.13), *global*, and applied equally to every bucket — and that
estimator works off the ratio of one bucket's likelihood to another's, where a
shared rescaling largely cancels. What would break an interval is miscalibration
that varies by bucket, and the per-bucket fits are the one place this audit
cannot rule that out (below). Task 13 also already tempers by τ = 0.35 and
measured its posterior as barely concentrating at all — 25.9% peak on one bucket
over 40 plies — so the interval it draws is wide for reasons that dwarf a 13%
logit rescale. Nothing here calls for changing it.

### Per bucket

| bucket | n | top-1 | log loss | ECE | fitted T |
| --- | --- | --- | --- | --- | --- |
| 1100 | 300 | 47.3% | 1.7333 | 0.00344 | 1.03 |
| 1200 | 320 | 43.1% | 1.8387 | 0.00455 | 1.31 |
| 1300 | 346 | 49.1% | 1.6063 | 0.00223 | 1.09 |
| 1400 | 394 | 55.1% | 1.3934 | 0.00033 | 0.97 |
| 1500 | 418 | 50.7% | 1.5405 | 0.00212 | 1.11 |
| 1600 | 348 | 54.0% | 1.4215 | 0.00101 | 1.15 |
| 1700 | 351 | 46.4% | 1.6734 | 0.00386 | 1.22 |
| 1800 | 313 | 50.2% | 1.5022 | 0.00100 | 1.16 |
| 1900 | 225 | 53.3% | 1.4783 | 0.00240 | 1.10 |

**The script prints "buckets genuinely differ, a per-bucket T may be worth it"
here, and that verdict should not be believed.** It fires on a spread of 0.338
against a threshold of 0.15 that was picked by guesswork, and each of those nine
fits is on roughly 167 rows. Two things argue for noise: the spread is driven
almost entirely by the two extremes (1200 at 1.31, 1400 at 0.97), and there is no
monotone trend in rating — a real rating-dependent miscalibration would be
unlikely to jump 1.31 → 1.09 → 0.97 → 1.11 across adjacent buckets. Treat one
global T as the finding and the per-bucket column as a thing to re-measure on a
larger corpus before anyone ships nine scalars.

Also worth reading against the grain: top-1 accuracy is *not* flat across buckets
(43.1% at 1200 against 55.1% at 1400), which is a reminder that these are ~300-row
samples and rating labels near a bucket edge are close to a coin flip.

## What it runs against

`web/scripts/fixtures/maia-calibration-sample.jsonl` — 3,964 rows drawn from the
[Lichess open database](https://database.lichess.org), which publishes every rated
game on the site monthly under **CC0** ("download, modify and redistribute them,
without asking for permission"), so a derived sample can live in this repo.

- **2026-06, rapid only.** The shipped weight is literally `maia_rapid.onnx`;
  scoring a blitz sample against it would quietly measure the wrong thing. The
  filter is the `Event` tag, not the filename — one monthly file holds every
  speed category mixed together.
- **1,982 games × 2 plies.** Positions inside one game share players, an opening
  and a plan, so they are not independent draws; capping each game at two plies
  stops one long game contributing 80 correlated rows.
- **Plies sampled uniformly, openings included.** Excluding book moves would
  flatter the model — they are the most predictable positions in chess — but they
  are also positions humans really face.
- **3,015 of the rows (76%) fall in the nine named buckets** 1100–1900, which is
  the scope Task 13's posterior lives over and therefore the headline scope here.
  The rest are below 1100 or 2000+, reported separately.
- **No training-data overlap.** Maia 2 was trained on games well before 2026-06.

Row schema, one JSON object per line:

```json
{"fen":"...","move":"e2e4","moverRating":1486,"opponentRating":1523,"ply":0,"game":"luZgzgI8"}
```

`ply` and `game` are two fields beyond what the spec asked for. They pay for
themselves in `verify-calibration-fixture.mjs`: `ply` parity against the FEN's
side-to-move is the check that catches an off-by-one, and `game` is provenance.

## The four scripts

| Script | What it does | Needs |
| --- | --- | --- |
| `build-maia-calibration-fixture.mjs` | streams a Lichess month, filters to rapid, writes the sample | network |
| `verify-calibration-harness.mjs` | scores synthetic predictors with known answers (spec checks 1–2) | nothing, ~10s |
| `verify-calibration-fixture.mjs` | invariants on all rows + 10 re-derived from raw PGN (spec check 4) | nothing, ~2s |
| `audit-maia-calibration.mjs` | the audit itself (spec checks 3 and 5) | the 93 MB weight |

```sh
cd web
node scripts/build-maia-calibration-fixture.mjs --selftest   # no network
node scripts/verify-calibration-harness.mjs
node scripts/verify-calibration-fixture.mjs
MAIA_CACHE_DIR=/somewhere/outside/the/repo node scripts/audit-maia-calibration.mjs
```

The audit caches the 93 MB weight and the move table on local disk between runs,
from the same pinned mirror commit `engineMaia.ts` fetches from. **Never commit
those.** `--rows 200 --gatePositions 25` gives a ~30-second smoke run.

### It runs the app's own pipeline, not a copy of it

The whole audit is worthless if this harness encodes positions even slightly
differently from the browser. So `web/scripts/lib/maiaNode.mjs` imports the real
thing from `web/lib/chess/engineMaia.ts` — `mirrorFen`, `mirrorMove`,
`boardToTensor`, `eloToCategory`, `legalPolicyIndices`, `decodePolicy` — and owns
only the ONNX session, which is the one part it genuinely cannot share
(`load()` throws outside a browser on purpose).

Two of those six needed adding to the export list. That is the only change this
task made to app code: a keyword each, no call site moved, no behaviour changed.
The alternative was a fourth copy of the plane packing and the legal-move
softmax, and this project has already paid once for two encoders quietly
disagreeing (`reviews/task-03-maia-review.md`, Q3).

Node 24 strips the TypeScript on import, so there is no build step and no loader
flag — it just works, at the cost of one `MODULE_TYPELESS_PACKAGE_JSON` warning
per run. `onnxruntime-web` runs fine under Node (Task 14's `probe-maia-graph.mjs`
established that), so `onnxruntime-node` and its native build are not needed,
despite the spec recommending them.

## Data engineering traps, since that was most of the work

**Lichess dumps open with a zstd *skippable* frame, and Node will not skip it.**
The files are written in the seekable-zstd layout, so the first bytes are magic
`50 2a 4d 18` and a length, before the first real frame. Fed that as-is,
`zlib.createZstdDecompress` emits **zero bytes and no error** — which reads
exactly like "this month has no rapid games in it" rather than like a decoder
problem. Stripping leading skippable frames by hand is what makes the stream work
at all.

**Node's decompressor stops at the end of the first frame** rather than
continuing into the next, capping one run at ~14,000 games — about 4,000 rows at
two plies each. That happens to be the sample size wanted, so it is documented
rather than fixed; the script says so explicitly instead of silently returning
short.

**The file is 28 GB and none of it is stored.** The stream is aborted the moment
the row target is hit — 93 MB read, 12.6 s. Consequence to state plainly: the
sample is the *first* N rapid games of the month, not a uniform draw from it.

**Native zstd needed no dependency.** The spec worried that
`zlib.zstdDecompress` landed in Node 23.8 while the repo's `@types/node` is
`^20`; the machine runs Node 24.16, so it is simply there.

## Verification

Every check ran on the shipped code. The point of the first two scripts is that
the audit's numbers are only worth reading if the thing computing them has been
shown to work on cases with known answers.

**`verify-calibration-harness.mjs` — 13/13.** Synthetic predictors, no chess:

- A perfectly-calibrated predictor scores ECE 0.00047, and the number **shrinks**
  as the sample grows (checked at two sizes — ECE is biased upward by finite
  samples, so "≈0 once" is a claim about the sample, not the estimator).
- Deliberately over- and under-confident predictors both score >5× worse on ECE
  and worse on log loss and Brier. Both directions, because a metric that only
  punished overconfidence would call an underconfident Maia healthy.
- Top-1 accuracy is **identical** across all three, which is the check that the
  code really does separate calibration from accuracy: sharpening a distribution
  cannot reorder it.
- The temperature fit recovers distortions it was not told about (injected ×1.6 →
  fitted 1.583; injected ×0.6 → fitted 0.593). Not in the spec — there is no
  point offering temperature scaling as the remedy without showing the machinery
  works on a case with a known answer.

**`verify-calibration-fixture.mjs` — 15/15.** All 3,964 rows: every FEN parses,
every stored move is legal at its stored FEN, no duplicate `(game, ply)`, every
rating plausible, and — the off-by-one detector — the FEN's side-to-move always
agrees with the ply parity. Then 10 rows re-derived from their source PGN by a
deliberately naive hand-rolled replay, confirming FEN, move and rating all match.
Different code reaching the same answer is the point; importing the builder's own
extraction function would have proved nothing.

**Self-consistency gate — the one that had to pass first.** Before any human row
is scored, the audit runs 300 real positions at each of the 9 buckets, treats
each resulting policy as ground truth, draws a simulated "play" from it in
software, and scores those draws through the *same* binning and ECE code the
human rows will meet. Since the outcomes were generated by exactly the
distribution being scored, a correct pipeline must recover ECE ≈ 0 — anything
else means the harness is broken rather than Maia being dishonest. Result:
**ECE 0.00063, MCE 0.0033, over 80,280 pairs.** That is the licence to read
everything above.

**Pipeline parity, inside the audit.** Before scoring anything it reproduces
three numbers written down before this task existed: the start-position value
head (`-0.1813`), `g8f6` after 1.e4 across three tiers (31.9 / 29.3 / 32.6%), and
93.9% on `exd4` in the move-index sanity position. It also asserts that
re-softmaxing the raw legal logits — the path temperature scaling needs —
reproduces `decodePolicy` exactly.

> One of those anchors failed the first time, at 92.8% instead of 93.9%. The
> cause was not the model: an earlier draft rebuilt that FEN from the prose
> description in `maia-notes.md` and dropped a black pawn. Copy anchor positions,
> never retype them — a 1.1-point miss looks exactly like drift.

Full run: 8/8 checks, **318 s**, 10,664 forward passes. The machine-readable
output is `web/scripts/fixtures/maia-calibration-report.json`, regenerable at any
time from the committed sample.

## What this does not establish

- **One month, one site, one speed category, and the first ~14,000 games of it.**
  Lichess rapid players are a self-selected population, and the sample is the
  head of the file rather than a uniform draw from the month. This says
  "calibrated against a same-shaped external sample", not "calibrated against
  Maia's own training distribution", which nobody outside CSSLab can check.
- **Rating labels are noisy.** `WhiteElo`/`BlackElo` are Glicko-2 point estimates
  with no deviation in the standard export, so a 1149 and a 1151 land in
  different buckets on a coin flip. That smears the per-bucket table
  independently of anything Maia does.
- **The per-bucket temperatures are underpowered**, as above. One global T is
  what the data supports.
- **Nothing here is applied.** The spec puts landing a correction inside
  `evaluateMaiaAt` out of scope, and this task respected that: T = 1.129 is
  measured and written down, not wired in. If it ever is, `evaluateMaiaAt` is the
  single place both the game loop and the rating estimator would inherit it from.
  Given the size of the effect, there is no urgency.
- **The effect on Task 13's credible interval is reasoned, not measured.** See
  above.
- **An encoding divergence exists and is deliberately not corrected here.**
  chess.js emits the en-passant field only when a capture is legal, while
  python-chess set it after any double push during Maia's training
  (`reviews/task-03-maia-review.md`, Q3). Every row in this corpus inherits the
  chess.js convention, which is also what the app feeds the model — so the audit
  measures the deployed pipeline honestly. It does mean neither this nor the app
  matches training-time inputs on the specific case of a double pawn push with no
  capture available.
