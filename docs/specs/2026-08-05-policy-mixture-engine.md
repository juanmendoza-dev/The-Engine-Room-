# Policy Mixture Engine — Design

Spec'd 2026-08-05, two days after `2026-08-03-engine-room-design.md`. Adds a
fourth `EngineType` that isn't a third model — it's arithmetic over the two
models already shipped. Stockfish already searches and scores moves; Maia
already predicts which move a human would play. This wires the two together
so one call returns a move picked from Stockfish's shortlist of moves that
don't lose, weighted toward whichever of those a human would actually play.

`score(m) = α · winProb(cp_m) + β · log P_maia(m)`, over Stockfish's top-N
`MultiPV` lines (plus one union exception, below), arg-maxed or sampled
through a temperature. Nothing here trains or fine-tunes either model — both
run exactly as today; this is a third function that calls both and does
floating-point arithmetic on their two outputs. That keeps it inside the "no
training, ever" constraint by construction, not by discipline.

## Constraints this bumps into

Full list is `2026-08-03-engine-room-design.md`; three shape a decision below:

- No training/fine-tuning of either model — pure inference + arithmetic.
- chess.js is the sole legality authority; the mixture may only select from
  `chess.moves()`. Easier to violate here than elsewhere, since the candidate
  comes from two sources and both need intersecting with legality.
- Zero budget, both engines client-side — no third model, no server call.

## Contract, and new/changed files

Every engine is reached through one function:
`getMoveFor(fen, config, onInfo?) => Promise<EngineMove>`. The mixture
implements this exact contract — `gameLoop.ts` and both pages don't need to
know it's calling two engines instead of one.

```
/lib/chess
  types.ts             → EngineType gains "mixture"; EngineConfig gains 4 fields
  engineStockfish.ts   → new getStockfishLines(); getStockfishMove() gets one new setoption
  engineMaia.ts        → unchanged — evaluateMaia() already returns what's needed
  engineMixture.ts     → new: getMixtureMove(), cp→winProb, candidate join, scoring
  engines.ts           → new "mixture" dispatch arm, new MIXTURE_PRESETS
```

## Turning on MultiPV

`setoption name MultiPV value N`, alongside the existing `UCI_LimitStrength`
/ `UCI_Elo` setoptions, before `position` / `go` — same slot in the handshake
`getStockfishMove` already uses.

**What changes in `engineStockfish.ts`.** Today `getStockfishMove` calls
`nextLine(w, l => l.startsWith("bestmove"), observe)`, reading only the
`bestmove` token. `nextLine` needs no change itself — a new
`getStockfishLines` calls it with the same `matches`, and an `observe` that
forwards to `onInfo` as before *and* parses `multipv` / `score` / `pv`. Setup
is otherwise identical to `getStockfishMove`'s `ucinewgame` / `position` /
`isready` sequence, with two deltas — the elo/limit-strength setoption
becomes conditional (see Wiring it in), plus one more setoption for `MultiPV`:

```ts
interface StockfishLine { multipv: number; uci: string; cp?: number; mate?: number }

// info depth 12 … multipv 1 score cp 34 … pv e2e4 e7e5 g1f3
const MULTIPV_RE = /\bmultipv (\d+)\b.*?\bscore (?:cp (-?\d+)|mate (-?\d+))\b.*?\bpv (\S+)/;

// "no elo" means UNCAPPED here, unlike getStockfishMove's `config.elo ?? 1500`
if (config.elo !== undefined) {
  w.postMessage("setoption name UCI_LimitStrength value true");
  w.postMessage(`setoption name UCI_Elo value ${config.elo}`);
} else {
  w.postMessage("setoption name UCI_LimitStrength value false");
}
w.postMessage(`setoption name MultiPV value ${multiPv}`);
// … position / isready / go movetime, unchanged from getStockfishMove …

const lines = new Map<number, StockfishLine>();
await nextLine(w, (l) => l.startsWith("bestmove"), (l) => {
  if (l.startsWith("info")) onInfo?.(l);
  const m = MULTIPV_RE.exec(l);
  if (!m) return;
  const [, idx, cp, mate, uci] = m;
  lines.set(Number(idx), { multipv: Number(idx), uci, cp: cp && Number(cp), mate: mate && Number(mate) });
});
return [...lines.values()].sort((a, b) => a.multipv - b.multipv);
```

Illustrative, not final — untested against this build's real `info` output.
Worth getting right:

- **No per-line "finished" signal exists** — UCI only signals completion for
  the search as a whole, via `bestmove`. The map keeps the *last* line seen
  per index, so "N scored lines" aren't guaranteed N *equally deep* ones, and
  with fewer than N legal moves there won't be N entries at all — the `Map`
  handles both naturally.
- **`getStockfishMove` needs one new line too**: explicit
  `setoption name MultiPV value 1`, every call — both share one live engine
  process, and an option set by one call persists until changed. Otherwise a
  plain config sharing a board with a mixture config would silently inherit
  whatever `MultiPV` the mixture last set.
- `getStockfishLines` **must** chain through the same `queue` as
  `getStockfishMove`, not a private one — it's what stops two live `go`
  commands on one process from resolving each other's promises.

**`MultiPV` × `UCI_LimitStrength` — what's known, what needs checking.**
Skill-limiting is documented, generally, as perturbing which near-best root
move becomes `bestmove` without a shallower search; this repo's own
`docs/reviews/task-02-stockfish-review.md` is consistent — at `MultiPV=1`, depth
stayed stable across ELOs while the move played varied. If that holds under
`MultiPV>1` too, the N reported `cp` values are honest per-line evals and
limit-strength only affects which one becomes `bestmove`, which the mixture
never reads anyway — but that's inference from one indirect data point, not
a direct check. **Needs checking**: capture raw `info` lines with
`UCI_LimitStrength` on vs. off at `MultiPV=5` and diff the `cp` numbers per
line; until then, the internal call sidesteps this by never setting
`UCI_LimitStrength` (see Wiring it in). Also unmeasured: whether `MultiPV`
itself costs search depth at the fixed 500ms budget — worth comparing
`info depth` at `MultiPV=1` vs. `=8`, the way `/dev/stockfish-test` compares
depth across ELOs today.

## The cp → win-probability transform

Raw centipawns and a log-probability aren't the same scale — `cp` is roughly
linear near 0 and saturates nowhere; `log P` is bounded above by 0 and
unbounded below. Blending them directly is the "unit-mismatched nonsense"
this needs to avoid. Using Lichess's win-percent model:

```
winPercent(cp) = 50 + 50 · (2 / (1 + exp(-0.00368208 · cp)) - 1)
               = 100 / (1 + exp(-0.00368208 · cp))
winProb(cp)    = 1 / (1 + exp(-0.00368208 · cp))     — the 0..1 form used here
```

**Where the constant comes from, and why it's a placeholder.** `0.00368208`
is Lichess's own fitted constant — a logistic regression of win probability
against Stockfish cp scores over real game outcomes. Not fit to this app's
exact build (18, lite, single-threaded), and Lichess has revised the model
across Stockfish/NNUE versions, so treat it as a reasonable published curve,
not one calibrated to this engine. **Better, unchecked**: recent Stockfish's
own `info … wdl <w> <d> <l>` (under `UCI_ShowWDL`) would be calibrated to
this exact network — whether this lite build advertises it is unchecked
(`getAdvertisedOptions()` would answer directly). Follow-up, not a blocker.

**A POV detail that's easy to get backwards**: `score cp`/`score mate` are
already mover-relative, not White's, and Maia's policy is naturally
mover-relative too — so no flip is needed. Same class of bug `mirrorFen` /
`mirrorMove` in `engineMaia.ts` already exists to avoid, just a different
instance of it.

**`score mate N` has no finite cp.** Clamping every mate line to a bare `1`
or `0` loses the fact that a MultiPV batch can contain several mating lines
at different distances — mate-in-1 should outrank mate-in-5. Map mate
distance to a synthetic cp that preserves ordering, then reuse the same
logistic:

```ts
const MATE_CP_BASE = 100_000; // logistic saturates long before this; sign + ordering are what matter
const scoreToCp = (l: { cp?: number; mate?: number }) =>
  l.cp !== undefined ? l.cp : Math.sign(l.mate!) * (MATE_CP_BASE - Math.abs(l.mate!));
```

(Aspiration-window re-searches can tag a `score` `lowerbound`/`upperbound` —
provisional, not final. `bestmove` should only land once the depth settles,
so skipping bound-flagged lines in the per-index map is a cheap guard.)

## Aligning the two move sets

**Join key**: the UCI move string (`from+to+promotion?`, e.g. `"e2e4"`,
`"e7e8q"`). Both sides already speak it — Stockfish natively in `pv`, Maia's
move table keyed by exactly `` `${from}${to}${promotion ?? ""}` `` (see
`evaluateMaia`). No translation, just a shared string key.

**Master list**: `chess.moves({ verbose: true })` for the current fen, same
rule as every engine. Stockfish's N lines are guaranteed legal (they came out
of its own search). Maia's policy is *already* filtered to legal moves and
softmax-renormalized over that full legal set — the mixture only
renormalizes once more, one level narrower, over its own smaller candidate
set. That piece is already built.

**A legal move outside Stockfish's top N** is excluded by default — the
premise is "pick among moves Stockfish's search already vouches for," so a
move it didn't shortlist is exactly what should be excluded. One exception:

**Maia's single favorite move, if not already in the top N, is pulled in
anyway, as a union, with a synthetic floor score** (worst reported line's cp
minus a fixed `FALLBACK_CP_PENALTY` — never better than anything Stockfish
actually evaluated). Reason: verification needs "α=0 reproduces Maia's
choice" to be an *exact* check, and a strict top-N-only set would fail that
whenever Maia's favorite isn't in the N, for reasons that have nothing to do
with a bug. The alternative (no union) is simpler and more honest to "moves
that don't lose," at the cost of that check becoming approximate — union is
the recommendation, specifically so verification's own checks stay clean.

**A legal move outside Maia's vocabulary entirely**: per
`docs/maia-notes.md`, the ~1880-entry move table is understood (not
verified here) to cover every from/to/underpromotion combination reachable in
legal chess, the same idea as lc0's 1858-entry table — rare to never, but
handled defensively regardless: probability `0` before renormalization, not a
crash.

**Renormalization**, over the final candidate set, with a small additive
epsilon: `prob' = (prob + ε) / Σ(prob + ε)`, `ε = 1e-6`. Load-bearing, not
just hygiene — for β=0 specifically. `Math.log(0)` is `-Infinity`, and
`0 * -Infinity` is `NaN`, not `0`, so "β is 0, the log term doesn't matter" is
exactly wrong: without the floor, a zero-mass candidate turns its whole score
`NaN` the moment β touches it, and `NaN` comparisons in an argmax misbehave
silently rather than throwing. The verification batch should include a
shortlisted, zero-Maia-mass move specifically to catch a regression here.

## The mixture itself

```ts
const scoreOf = (c: Candidate, alpha: number, beta: number) => alpha * c.winProb + beta * Math.log(c.maiaProb);

function selectMove(candidates: Candidate[], alpha: number, beta: number, temperature: number) {
  const scores = candidates.map((c) => scoreOf(c, alpha, beta));
  if (temperature <= 0) return candidates[argmax(scores)];
  const weights = scores.map((s) => Math.exp(s / temperature));
  return candidates[sampleWeighted(weights)];
}
```

`temperature = 0` is argmax — deterministic, needed for the verification
plan's checks. `temperature = 1` samples proportional to raw score; higher
flattens toward uniform, which is what keeps repeated self-play games at one
config from all playing out identically.

**α and β share a redundant degree of freedom with temperature**: scaling
both by a constant k is equivalent to dividing T by k, since `score / T` is
what gets exponentiated. So there are really two effective free parameters,
not three — the ratio α:β (which move wins as `T → 0`), and the score's scale
relative to T (how sharp or flat sampling is). Practical convention: fix
α = 1, only tune β and T.

## Calibrating α, β (and T) to a target strength

No closed form for "what β plays like 1600." The loop is empirical:

1. **Spot-check the ratio by hand**, at `T=0`: build a position where
   Stockfish's #1 and #2 lines are close in `cp` but Maia strongly prefers
   one, and confirm the chosen β follows Maia when the gap is small and
   Stockfish once it's large — the design goal, made checkable by eye before
   spending compute on match play.
2. **Once a plausible β range is narrowed, run SPRT matches** (per
   `2026-08-05-sprt-engine-ratings.md`) against fixed references — Stockfish
   at a known `UCI_Elo`, or Maia alone — and see which β scores ~50%.
3. **Repeat for T** once α:β is settled, if variety matters more than
   determinism.

**No strength claim about this engine is meaningful without step 2 actually
run.** This spec only specifies the loop — "plays like ~1600" is a target,
not a result, until the SPRT harness reports one.

## Wiring it in

```ts
export type EngineType = "stockfish" | "maia" | "human" | "mixture";

export interface EngineConfig {
  type: EngineType;
  label: string;
  elo?: number;          // stockfish only (UCI_Elo)
  ratingTier?: number;   // maia only, or the mixture's internal Maia call (1100-1900)
  multiPv?: number;      // mixture only: N candidate lines from Stockfish
  alpha?: number;        // mixture only: weight on Stockfish win-probability
  beta?: number;         // mixture only: weight on Maia log-probability
  temperature?: number;  // mixture only: 0 = argmax, >0 = softmax sampling
}
```

Four new optional fields, flat, no nested "mixture config" object.
`ratingTier` is reused as-is, so the same `config` passes straight into both
`getStockfishLines(fen, config, config.multiPv ?? 8, onInfo)` and
`evaluateMaia(fen, config)` — no sub-config construction.

**Why the internal Stockfish call skips `UCI_LimitStrength` entirely.**
"Strength" could mean two things: weakening Stockfish's move *choice*
(`UCI_Elo`, today), or an honest per-move evaluation so this engine's *own*
α/β/T does the shaping instead. The mixture wants only the second — noised
`cp` numbers would make calibration chase a target tangled up with whatever
limit-strength does internally (still unconfirmed, per Turning on MultiPV).
So `elo` stays unset on a mixture config, and `getStockfishLines` treats a
missing `elo` as uncapped rather than defaulting to 1500 the way
`getStockfishMove` does — safe, since every existing Stockfish preset already
sets an explicit `elo`. A mixture config that *does* get an `elo` by mistake
would silently get capped again — worth a comment or a dev-time warning.

**Dispatch** — one more `if`, matching the existing style:
`if (config.type === "mixture") return getMixtureMove(fen, config, onInfo);`

**On exhaustiveness**: grepped for a `switch` over `EngineType` /
`config.type` — there isn't one. Every consumer uses `===` comparisons
(`config.type === "maia"`), which TypeScript doesn't flag for a new union
member — they just evaluate to `false`. So the risk isn't a compile break,
it's silent no-op UI:

- `web/app/model-1v1/page.tsx`'s `eloLabel()` falls through to
  `return config.type` for anything not stockfish/maia — a mixture config
  would show the literal word "mixture" on the VS card. Needs one branch.
- **Two lookalike checks need *opposite* treatment**, in both page files:
  `<MaiaLoadNotice active={... type === "maia"} />` **must** also match
  `"mixture"` (same ~89MB download), but the ki-charge bar's
  `type === "maia" ? INDETERMINATE : 0` **must not** — the mixture's internal
  Stockfish call has a real depth to report via the same `onInfo`
  passthrough, so a naive "add mixture everywhere" pass gets one right and
  the other backwards. A shared `usesMaiaWeights(config)` helper beats
  repeating the `||` twice.
- `web/lib/games/types.ts`'s `GamePlayer.type` comment goes stale (a comment, not
  a type — nothing breaks, worth a one-line fix per AGENTS.md). No
  `GameRecord` schema change needed; storage already covers `"mixture"`.

**Presets** — one to start, deliberately not labeled with a fake strength
number, matching the design doc's "real engine-reported ELO, not a faked
label" principle for Stockfish's own presets:

```ts
export const MIXTURE_PRESETS: EngineConfig[] = [
  { type: "mixture", label: "Policy Mixture (uncalibrated)", ratingTier: 1500, multiPv: 8, alpha: 1, beta: 1, temperature: 0 },
];
```

`multiPv: 8` and `1:1` are starting guesses, not calibrated values — exactly
what Calibration step 1 should replace. Add to `ALL_ENGINE_PRESETS`;
`EngineConfigPicker` is generic over the preset list, so this reaches both
screens for free.

## Latency

Stockfish's internal call: fixed 500ms (`MOVE_TIME_MS`) regardless of
`MultiPV` — `movetime` governs wall clock, not line count. Maia's internal
call: ~35ms once loaded (the ~89MB cold-cache download is the existing,
unrelated cost from `docs/maia-notes.md`, inherited unchanged).

**The two calls can run concurrently, and should** — same fen, no shared
mutable state, and unlike two Stockfish calls, no contention: Stockfish goes
through the shared, serialized Worker `queue`; Maia runs its wasm session
directly on the main thread (`ort.env.wasm.numThreads = 1`). So
`Promise.all([getStockfishLines(...), evaluateMaia(...)])` costs
`max(~500, ~35) ≈ 500ms`, not `535ms` serial — a small, free win (~7%) since
neither call's input depends on the other's output.

**What this does to the game loop's pacing: nothing measurable.**
`runModelGame` just awaits `getMoveFor(...)` once, then sleeps `moveDelayMs`
(default 350ms) or the FX hit-stop override (350/470/700/2000ms by tier). A
mixture ply costs ~500ms think plus the same pacing a pure-Stockfish ply
already costs — bottlenecked by Stockfish's fixed budget either way. No FX or
pacing constants need retuning. (Could mixture-vs-mixture starve the shared
`queue`? Moot — `runModelGame` is turn-based, never two in-flight calls at
once; only matters for a hypothetical multi-game feature.)

## Verification plan

No automated suite, matching the rest of this app — manual/scripted checks
like `/dev/stockfish-test` and `/dev/maia-test`. Three make the blend
falsifiable rather than merely plausible:

1. **β=0 reproduces Stockfish's choice** — precisely, matches the top
   (`multipv 1`) line among the N reported, *not* necessarily the raw
   `bestmove` token (those could diverge under `UCI_LimitStrength`, per the
   flagged open question). Run with the internal call exactly as specified
   (no limit-strength), compared against a plain `getStockfishMove` call with
   no `elo` set, across opening/midgame/endgame positions.
2. **α=0 reproduces Maia's choice**, exactly, via the union rule above —
   compare directly against `getMaiaMove(fen, config)` on the same batch. If
   it only matches "most of the time," the union logic wasn't implemented as
   specified — a real bug, not acceptable drift.
3. **Every returned move is chess.js-legal**, across a few hundred
   positions — cheapest of the three, purely mechanical. Feed FENs (self-play
   walks or a fixed corpus) through `getMixtureMove`, assert membership in
   `chess.moves({ verbose: true })`.

Beyond those three: one handpicked "close eval, human disagrees" position to
eyeball the blend doing what it's for; one position with a shortlisted,
zero-Maia-mass move to catch the `NaN` failure mode above; and a
repeated-call check at `T>0` confirming move choice actually varies —
otherwise temperature is dead code.

**Actual playing strength is out of scope for this checklist** — entirely
`2026-08-05-sprt-engine-ratings.md`'s job. No Elo claim about this engine is
meaningful until that harness produces one.

## Risks

- MultiPV × UCI_LimitStrength interaction is genuinely unverified, not just
  unstated — sidestepped here, not resolved (see Turning on MultiPV).
- MultiPV's depth cost at fixed movetime is unmeasured — a deeper-searched
  line's `cp` is more trustworthy than a shallower one, invisibly so.
- The candidate set is Stockfish's shortlist, not the full legal-move set —
  this is "Maia restricted to whatever Stockfish vouched for," not "Maia with
  a blunder filter over every legal move." Widening it costs the depth
  tradeoff above.
- Calibration is a guess until SPRT runs — `1:1` means "no opinion," not
  "balanced," given the winProb/logP unit mismatch.
- Maia vocabulary coverage is assumed, not proven, complete — handled
  defensively, not assumed impossible.

## Out of scope

- Training or fine-tuning either model — the one constraint that can never
  move. Postprocessing arithmetic only.
- Per-phase or per-move-adaptive α/β; opening books, pondering, tablebases
  for the internal call. One fixed `(α, β, T)` per `EngineConfig`, full stop.
- Fixing Maia's cold-cache download — pre-existing, orthogonal, documented in
  `docs/maia-notes.md`.
- A worker pool, a transposition cache, a surprisal metric — see
  Cross-references. This spec assumes today's single shared Stockfish worker
  and uncached Maia session, and needs no sibling spec to land first.
- Measuring actual playing strength — `2026-08-05-sprt-engine-ratings.md`'s
  job, not this doc's.

## Cross-references

- **`2026-08-05-sprt-engine-ratings.md`** — the only legitimate source of a
  strength claim about this engine (see Calibration).
- **`2026-08-05-move-surprisal.md`** — "surprisal" of a move is `-log P(move)`,
  the exact negative of this spec's `log P_maia(m)` term. Worth exposing
  "Maia's probability for one legal move" as one shared primitive rather than
  two call sites re-deriving a softmax independently.
- **`2026-08-05-engine-worker-pool.md`** — this spec assumes today's single
  shared Worker + queue; a pool wouldn't need to special-case the mixture's
  Stockfish sub-call, but would change Latency's concurrency numbers, which
  assume one live Stockfish call app-wide.
- **`2026-08-05-zobrist-transposition-cache.md`** — not needed here, but
  relevant to Calibration: SPRT sweeps replay many self-play games revisiting
  identical openings, which a transposition cache would speed up.
