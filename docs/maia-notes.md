# Maia integration notes

Findings from Task 3's timeboxed spike. Written so the next person doesn't repeat
the archaeology.

**Timebox:** started 12:03:48, CP1 concluded ~12:09 — **≈5 minutes, well inside the
15-minute CP1 budget**, with ~84 minutes of the box still unspent.

**Outcome: Maia works.** `getMaiaMove(fen, config)` returns human-plausible legal
moves in ~35 ms, using **Maia 2 "rapid" (MIT)** rather than Maia 3 (AGPL-3.0) —
see "Licensing" and "Results" below. One residual question is flagged honestly
under Results rather than glossed over.

Sequence: CP1 made CP2–CP6 unnecessary; work then paused for a licensing decision
(Maia 3's weights are AGPL-3.0), and resumed on Maia 2 once that was settled.

---

## Headline: the plan was aimed at the wrong Maia

The build plan and spec assumed **original Maia** — lc0-format `.pb.gz` weights,
one network per rating tier, converted to ONNX with `lc0 leela2onnx`, taking lc0's
112 input planes including move history.

That's a real thing and the plan's description of it was accurate. But there's a
newer official model, **Maia 3**, which is what CSSLab actually runs in production
on maiachess.com, and it is a completely different architecture that is far easier
to integrate:

| | Original Maia (planned) | Maia 3 (found) |
| --- | --- | --- |
| Format | lc0 `.pb.gz`, needs conversion | ONNX already, no conversion |
| Requires lc0 binary | yes | **no** |
| Input | ~112 planes of 8×8, incl. move history | `(64, 12)` piece tokens, **no history** |
| Rating | one network per tier | `elo_self` / `elo_oppo` as **continuous model inputs** |
| Files for 3 tiers | 3 `.onnx` | **1 `.onnx`** |
| Policy output | lc0 move encoding | 4352-dim, own index table |
| Value output | scalar / WDL | 3-dim loss/draw/win logits |

So the whole conversion pipeline — CP2 (source `.pb.gz`), CP3 (lc0 + `leela2onnx`),
CP4 (graph archaeology), and the history-plane question — simply evaporates. Five
minutes of searching removed the three riskiest checkpoints in the task. This is
the entire argument for doing CP1 first rather than getting on with "the real
work".

## Where everything lives

- **Model:** `https://www.maiachess.com/maia3/maia3_simplified.onnx` — HTTP 200,
  **43.57 MB**, `application/octet-stream`. Note `maiachess.com` 308-redirects;
  use the `www.` host.
  Default in the reference app is the relative path `/maia3/maia3_simplified.onnx`,
  overridable via `NEXT_PUBLIC_MAIA_MODEL_URL`, version via
  `NEXT_PUBLIC_MAIA_MODEL_VERSION` (currently `'3'`).
- **Reference implementation:** `CSSLab/maia-platform-frontend`
  - `src/lib/engine/tensor.ts` — encoding, mirroring, move index lookup
  - `src/lib/engine/maia.ts` — inference + output decode (`processOutputsMaia3`)
  - `web/public/maia-worker.js` — ONNX session in a Web Worker, IndexedDB model cache
- **Move index tables:** `src/lib/engine/data/all_moves_maia3.json` (58.7 KB) and
  `all_moves_maia3_reversed.json` (67.2 KB). Small enough to commit.

## Where *our* copies live, and why not a GitHub Release

The app no longer fetches from CSSLab. Both files are mirrored byte-for-byte in
**`juanmendoza-dev/engine-room-assets`** (`maia2/`), fetched at runtime from
`raw.githubusercontent.com` pinned to commit
`7c916f4d794ff411ffe6d0be85c8b1c75e61c8fe`.

Why we moved off the upstream URL: CSSLab have **deleted `maia_rapid.onnx` from
their `main`**, so the pinned commit `e23a50e` was the only thing still serving
it — a single point of failure on the demo path that we didn't control.

Why a separate repo rather than `web/public/maia/` in this one: 93 MB in this repo's
history forever, plus ~93 MB of Vercel egress per page load (about 1,000 loads
against Hobby's 100 GB/month). The separate repo keeps the clone lean and puts
the egress on GitHub — the same trade CSSLab made when they moved these files off
their own hosting.

**Why not a GitHub Release, which is the obvious answer:** release assets are
served from `release-assets.githubusercontent.com`, an Azure blob that sends **no
CORS headers at all** — no `Access-Control-Allow-Origin`, so a browser `fetch()`
of one dies with a bare "Failed to fetch". `raw.githubusercontent.com` sends
`Access-Control-Allow-Origin: *`. Both checked with `curl -H Origin:` *and* with
a real `fetch()` from our own origin in headless Chrome, because the header dump
alone is the kind of thing that's easy to misread. A Release was built, tested,
found unusable, and deleted — don't retry it.

Verification that the mirror is faithful, for anyone who needs to re-do it:

```sh
# sha256, ours vs upstream — must match
curl -sSL "https://raw.githubusercontent.com/juanmendoza-dev/engine-room-assets/7c916f4d794ff411ffe6d0be85c8b1c75e61c8fe/maia2/maia_rapid.onnx" | sha256sum
# 027ddb8c1a8b7235b6e51827cffe325f9cb95fd4523dce65a131547c034ccfc9
```

`all_moves.json`'s git blob SHA in our mirror is `1698c2296e…`, which is the same
blob SHA it has upstream — independent confirmation it wasn't mangled in transit
(`*.onnx binary` in `.gitattributes` there covers the weights for the same
reason). **No Git LFS**, deliberately: `raw.githubusercontent.com` serves LFS
pointer text rather than content, so LFS would break this outright — the same
trap `docs/deployment.md` §4 flags for Vercel builds.

## The ONNX interface, confirmed from the reference worker

```js
feeds = {
  tokens:    Tensor('float32', ..., [batch, 64, 12]),
  elo_self:  Tensor('float32', ..., [batch]),
  elo_oppo:  Tensor('float32', ..., [batch]),
}
// outputs: result.logits_move (4352 per item), result.logits_value (3 per item)
```

## How encoding works

1. **Always white's perspective.** If it's Black to move, mirror the FEN first —
   vertical flip, swap piece colours, swap castling rights, mirror the en passant
   square, flip active colour. Then the board is encoded as if White were moving.
2. **Tokens:** `Float32Array(64 * 12)`, set `tensor[square * 12 + pieceIdx] = 1`,
   where `square = row * 8 + file` and piece order is `P N B R Q K p n b r q k`.
3. **Legal-move mask:** `Float32Array(4352)`, index via
   `allMovesMaia3[from + to + promotion]`, computed **on the mirrored board**.
4. **Decode:** softmax over the legal indices only; map index → move via the
   reversed table; if Black was to move, `mirrorMove()` each move to get back to
   real board coordinates. Value: softmax the 3 LDW logits,
   `winProb = (W + 0.5 · D) / total`, then `1 - winProb` if Black to move.

## Two real limitations of Maia 3, worth knowing

1. **The input encodes piece placement only.** No castling-rights channel, no en
   passant channel, no explicit side-to-move channel (side to move is implicit in
   the always-white-perspective mirroring). The older 18-channel path in the same
   reference file *does* encode castling and en passant, but `boardToMaia3Tokens`
   does not. So the model cannot distinguish a position where castling is still
   available from one where it isn't. That's a property of the model, not a bug to
   fix, but it will occasionally show up as odd play around castling.
2. **43.57 MB is a real download.** The reference app caches it in IndexedDB
   specifically because of this, and shows a progress bar during the fetch. For our
   MVP the browser HTTP cache is probably enough, but first load of a Maia game
   will not be instant, and Task 6 should not assume it is.

## Why this stopped for a decision

The approved verification design made **V1 — lc0 parity** the load-bearing check:
run the same weights through lc0 and require my pipeline's policy and value to
match. That check is **impossible for Maia 3**, because Maia 3 is not an lc0
network — lc0 cannot load or run it. There is no lc0 in this pipeline at all.

Silently dropping the primary verification check that a reviewer specifically added
would be exactly the sort of thing the last two reviews caught. So this stops here
with findings recorded, rather than proceeding on a verification plan nobody has
agreed to.

Proposed replacement, for approval — see the PR discussion:

- **ELO responsiveness (new primary).** `elo_self` is a continuous input, so the
  same FEN at 1100 vs 1900 must produce measurably different policy
  distributions. If the elo inputs are mis-wired, swapped, or ignored, the output
  is identical or nonsense. This is genuinely discriminating — and notably it's the
  check that Stockfish *couldn't* provide, since its search depth was identical
  across ELOs.
- **Index-table round-trip.** Assert `reversed[table[m]] === m` across all 4352
  entries. Cheap, complete, and catches a mismatched or corrupted table pair.
- **Reference parity.** Compare my encode/decode against the reference logic on the
  same FENs. Weaker than V1 was — it confirms the port is faithful, not that the
  reference is right — but the reference is what maiachess.com runs in production,
  so it's well exercised.
- **Value sanity, policy plausibility, legality** (old V2/V3/V5) carry over
  unchanged.
- **Mirror invariance** (old V4) is more meaningful here than for lc0, since
  mirroring is explicit load-bearing code in this pipeline rather than implicit in
  the encoder — but the same self-confirmation caution applies: build the mirrored
  FEN independently, not by calling the reference's own `mirrorFEN`.

## Licensing — why Maia 2, not Maia 3

| Component | Licence |
| --- | --- |
| `CSSLab/maia3` (Maia 3 code **and weights**) | **AGPL-3.0** |
| `CSSLab/maia-platform-frontend` (reference encode/decode) | GPL-3.0 |
| `CSSLab/maia2` | **MIT** |
| Stockfish (already shipped on `main`) | GPL-3.0 |

AGPL-3.0's network clause reaches software offered to users over a network, which
is what a deployed Vercel app is. So Maia 3 would effectively make this project
AGPL. Maia 2 is MIT and — as a bonus — has a *richer* input encoding than Maia 3
(18 planes including castling rights and en passant, which Maia 3 lacks entirely),
plus rating buckets that line up with the design doc's 1100/1500/1900 tiers.

Maia 2 "rapid" as ONNX is at a pinned commit of the frontend repo:
`.../maia-platform-frontend/e23a50e/public/maia2/maia_rapid.onnx` — 88.93 MB.

**Nothing third-party is committed to this repo.** Both the weights and the move
table are fetched at runtime from GitHub raw, which serves
`Access-Control-Allow-Origin: *` (verified). That keeps ~89 MB out of the repo and
off our Vercel bandwidth — the same reason CSSLab's own git log shows them moving
these files off their hosting ("to eliminate Vercel bandwidth costs").

Still outstanding: the repo has **no `LICENSE` file** despite already shipping
GPL-3.0 Stockfish. That predates this task but should be fixed.

## Results

Verified against a production build in headless Chrome (`web/scripts/cdp-verify.mjs`).

**Graph interface — confirmed, not assumed:**

```
inputs:  boards, elo_self, elo_oppo
outputs: logits_maia, logits_side_info, logits_value
```

`boards` is float32 `[1, 18, 8, 8]`; `elo_self` / `elo_oppo` are **int64 bucket
indices**, not raw ratings. `logits_side_info` is a third head we don't use.

**Rating responsiveness (the primary check) — PASS.**

```
elo 1100  g8f6 31.9%  b8c6 23.8%  e7e5 6.8%
elo 1500  g8f6 29.3%  b8c6 25.8%  e7e5 7.0%
elo 1900  g8f6 32.6%  b8c6 25.8%  e7e5 8.3%
```

Same FEN, three ratings, measurably different distributions. This is the check
that matters: if `elo_self` were being silently dropped (wrong tensor name, wrong
dtype) the three rows would be **byte-identical**. They aren't, so the rating is
genuinely consumed. Honest limit: the top move is the same at all three and the
deltas are 1–3 points, so this proves the input is wired — not that it produces a
large strength difference. Whole-game results remain the real test of that, same
conclusion as Stockfish's ELO.

**Both elo inputs are independently wired — confirmed later, and the check above
did not show it.** Worth being precise about, because it reads like it did. The
responsiveness table varied `ratingTier`, which `evaluateMaia` feeds to **both**
`elo_self` and `elo_oppo`. So it proves the *pair* is consumed and isolates
neither. Task 13 added `evaluateMaiaAt(fen, selfCategory, oppoCategory)` and swept
them one at a time on the same FEN (reply to 1.e4):

```
elo_oppo pinned at 1500, elo_self 1100 -> 1900:  9/9 distinct distributions
elo_self pinned at 1500, elo_oppo 1100 -> 1900:  9/9 distinct distributions

  self=1100 oppo=1500  g8f6 36.6%  b8c6 19.2%  g8h6 9.6%
  self=1900 oppo=1500  g8f6 29.8%  b8c6 27.5%  e7e5 6.9%
  self=1500 oppo=1100  g8f6 29.7%  b8c6 24.6%  g8h6 9.3%
  self=1500 oppo=1900  g8f6 32.4%  b8c6 21.9%  g8h6 9.3%
```

Both inputs move the policy on their own. Note the `self` sweep is not monotonic
(`b8c6` climbs 19.2% → 27.5% but `g8f6` dips and recovers), so don't expect the
buckets to lie on a line.

**Adjacent buckets are nearly indistinguishable, and that has consequences.**
The honest limit already noted above turns out to be the dominant fact about this
model for any inference built on it. Neighbouring buckets differ by 1–3 points on
a given move, so 40 plies of a player's own moves can locate them within about
±1 bucket and no better. Task 13's write-up in
`docs/plans/2026-08-03-engine-room-implementation.md` has the numbers.

**Concurrent `session.run()` on one session throws `Session already started`.**
Not a subtlety — ORT rejects it outright. Found by loading a page that ran two
`evaluateMaia` calls at once under React StrictMode's double mount. It never
mattered while the game loop was the only caller (strictly sequential), but any
second caller collides with it. `engineMaia.ts` now serialises every run through
one promise chain, which costs a sequential caller a microtask and changes no
output. If you add another Maia caller, you get that for free — don't reintroduce
a second session to work around it.

**Move index table round-trip — PASS.** 1880 entries, 0 mismatches. (Note 1880,
not lc0's 1858 — different move space.)

**Mirror invariance — PASS, and the review's warning about it was exactly right.**

```
white-to-move : e3d3  value 0.2076
black mirrored: e6d6  value 0.2076   value delta 0.0000
```

The spec claimed that hand-writing the mirrored FEN, rather than generating it with
the encoder's own `mirrorFen`, would stop this check being self-confirming. **That
was wrong, and this output proves it.** Mirroring is an involution, so for a
black-to-move position the encoder's internal mirror undoes the test's mirror and
produces a byte-identical tensor no matter how the test FEN was authored — which is
why the value delta is exactly `0.0000` rather than merely close. The tautology is
in the maths, not in the test construction.

What it does establish, which is narrow but real: `mirrorFen` is a correct
involution here, and `mirrorMove` maps the output back to true board coordinates
correctly (`e3d3` → `e6d6`). Perspective handling exists and is applied. It says
nothing about whether the plane layout is right.

**Value head — PASS.** Start position `-0.1813`; White up a queen `+0.4583`.
Direction is right. Reported as the raw scalar with no transform applied; note the
start position is not ~0, so don't read this as a centipawn-like eval.

**Legality — PASS** (necessary, not sufficient): all three FENs produced
chess.js-legal moves.

**End-to-end through the real app — PASS.** After Model 1v1 (#8) merged, Maia was
wired into `web/lib/chess/engines.ts` using the three-step seam that PR's author left
in place, and a real game was driven on the actual `/model-1v1` screen: **Maia 1100
as White versus Stockfish 1320 as Black, 11 plies, no console errors**. So the
contract holds all the way through — my engine, their registry, their game loop,
their UI — not just on the dev page.

Two things that came out of that run:

- The first Maia move takes a long time on a cold cache, because it's fetching
  89 MB. An earlier attempt reported "PASS" while the board was still empty; the
  page said `0 PLIES / No moves yet` and my throwaway driver's regex had matched
  "MAIA **1100**" as a ply count (`\s*` crossed a newline into "MOVES"). Worth
  knowing if anyone writes a similar check: anchor on `PLIES` and don't let
  whitespace classes span lines.
- Maia 1100 played `Nc3` then retreated `Nb1`, consistent with the knight-move
  preference noted above and with 1100-rated play being deliberately weak.

**Speed: ~35 ms per move**, versus Stockfish's ~500 ms. Task 6 should know these
are an order of magnitude apart — a Maia-vs-Maia game will feel very different in
pace from Stockfish-vs-Stockfish, and the inter-move delay probably wants to be
per-engine rather than global.

**Encoder vs hand-computed ground truth — PASS.** This is the check that actually
validates the encoding, and the first version of these notes didn't have it. Plane
indices were derived on paper from the layout (`piece * 64 + row * 8 + file`,
`row = 7 - rank`, order `P N B R Q K p n b r q k`) and asserted directly:

```
PASS  white rook a1  -> idx 192 = 1      PASS  black pawn a7 -> idx 432 = 1
PASS  white queen d1 -> idx 259 = 1      PASS  black rook a8 -> idx 632 = 1
PASS  white king e1  -> idx 324 = 1      PASS  black king e8 -> idx 764 = 1
PASS  white pawn a2  -> idx   8 = 1
PASS  352 bits set (32 pieces + 64 turn + 256 castling, 0 en passant)
PASS  castling planes empty when the FEN carries no rights
```

Independent of the reference implementation, so it can actually fail.

**Policy index alignment — PASS, and decisive.** The remaining gap all the other
checks left open was whether `logits_maia[i]` really means `all_moves.json`'s move
`i`. A scrambled mapping would still produce legal moves with plausible-looking
probabilities, so it needs a position with an unambiguous answer: black's queen on
d4, undefended, capturable by `exd4` for nothing.

```
e3d4 93.9%   g1f3 1.1%   c2c3 1.1%
```

93.9% of the mass on exactly that capture. A wrong mapping cannot do that.

### The residual question — resolved

Earlier drafts of these notes flagged a worry: the top move from the start position
is `g1f3` and the top reply to 1.e4 is `g8f6` (~32%) with `e7e5` down at 6.8–8.3%.
For human play at 1100–1900 that's odd — `e4`/`e5`/`c5` dominate real data — and per
this task's central trap, a systematically wrong encoder would produce exactly that
kind of legal-but-off output.

**It is not a bug in our integration.** The encoder is verified against hand-computed
ground truth, the move table is pinned to the model's own commit and round-trips
cleanly, and the index mapping puts 93.9% on a free queen capture. Also corroborating:
the mid-opening test position returns `Bb5`, which is the main line (Ruy Lopez) in
that exact position — precisely what a human-imitation model should say.

So this is how `maia_rapid` behaves, and my plausibility band was simply too loose to
be interesting. Recorded rather than deleted, because "the model's opening preferences
look mildly unusual" is worth knowing when watching Model 1v1, and because the
reasoning chain that ruled out a bug is the useful part.

### A hypothesis I had, and disproved

Worth recording because it was wrong for an instructive reason. I suspected the move
table was drifting from the model: the model was pinned to commit `e23a50e` but the
table was fetched unpinned from `main`, months of commits later. Misaligned policy
indices would give exactly the observed symptom, and it neatly explained why the value
head looked correct while the policy looked off — the value head doesn't use the table.

It's false. The table has moved paths twice upstream
(`hooks/useMaiaEngine/data/` → `providers/MaiaEngineContextProvider/data/` →
`web/lib/engine/data/`) but both moves were **pure renames**: GitHub reports
`additions: 0, deletions: 0`, and the git blob SHA at `e23a50e` and on `main` is the
same object, `1698c229…`, 25298 bytes. Confirmed independently by the fact that
pinning the table changed the policy output not at all — the numbers came back
byte-identical.

The table is now pinned to `e23a50e` anyway, so model and table cannot drift apart in
future.

## Batching, and what the value head actually says (measured 2026-08-05, Task 14)

Findings from `web/scripts/probe-maia-graph.mjs`, which runs the graph under **Node**
rather than a browser — `onnxruntime-web`'s wasm backend works fine outside one, so
re-checking any of this costs a few seconds and no 93 MB download. Point it at a
local copy of the model.

**The batch axis is dynamic.** `session.inputMetadata` declares
`boards: ["batch_size",18,8,8]` with `elo_self`/`elo_oppo` as `["batch_size"]`, so
`[N,18,8,8]` runs as-is — this was the load-bearing unknown for the rollouts
feature and it's a non-issue. Output is row-major `[N,1880]` with `logits_value`
as `[N]`, and row *i* came back **bit-identical** (max abs diff 0.000e+0, not
merely close) to evaluating that position alone. Verified with two *distinct*
positions, because two copies of one would agree even if the rows were
transposed. Varying the batch size within one session is also fine — no
per-shape penalty worth measuring.

**Batching buys about 10%, not a multiple.** Worth knowing before designing
anything around it:

| Batch | Per pass | Per position |
| --- | --- | --- |
| 1 | 27ms | 27.3ms |
| 9 | 222ms | 24.7ms |
| 30 | 727ms | 24.2ms |
| 100 | 2461ms | 24.6ms |

Total FLOPs are conserved and this backend gets almost nothing extra from a
larger batch. So budget any batched workload as `positions × ~25ms` and treat
the win as collapsing thousands of sequential awaits into tens — scheduling and
code shape, not wall clock.

**`logits_value` observed range, mover's perspective:** -0.566 to +1.076 across
deliberately extreme positions. It is directional and nothing more:

| Value | Position |
| --- | --- |
| +1.076 | mover has mate in 1 |
| +0.602 | mover up rook + queen |
| +0.458 | mover up a queen |
| +0.030 | dead drawn K v K |
| -0.181 | start position |
| -0.455 | mover gets mated next move |
| -0.566 | mover down a queen |

Note the ordering error: **"about to be mated" reads better than "down a
queen."** Any transform of this scalar into a win probability inherits that, so
keep the squashing wide and don't let it produce confident numbers.

**The elo_self sweep is a trap, and it nearly cost a wrong constant.** Sweeping
`elo_self` with `elo_oppo` pinned at 1500 moves the value by **0.88** across the
nine categories (-0.242 at category 1 to +0.636 at 9) — more than a whole queen
of material. Read alone that looks like a rating-dependent bias any value-based
maths would have to subtract out. It isn't: with the two inputs **matched**, the
same sweep is flat to within 0.04 (mean -0.061 at category 1, -0.021 at 9, over
four objectively level positions).

So the model is pricing a rating *gap*, correctly — a 1100 really is worse off
against a 1500 — and that is signal to keep, not bias to remove. The number to
centre on is the matched-tier one: **-0.047 mean, spanning -0.229 to +0.034.**
The control mattered more than the measurement here; the obvious sweep pointed
the opposite way.

## Maia self-play draws in 8 plies (found 2026-08-05, Task 15)

Maia against Maia on `/model-1v1` plays `1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8`
and is declared a draw by threefold repetition. Identical at `ratingTier` 1100 and
1500. Found while verifying the policy mixture, which inherits it — at `β = 1` that
blend is Maia-dominated, so it reproduces the same shuffle move for move — but this
is Maia's own behaviour and has presumably been true since Task 3. It went unnoticed
because `/model-1v1` defaults to Stockfish 1320 vs 2800.

**Why.** Maia 2's input has no move-history planes (see *Two real limitations* above
and the 18-plane layout — 12 piece planes, side to move, 4 castling, en passant, and
nothing about how the position was reached). So at the position after `1. Nf3 Nf6`,
the model cannot see that it just played Nf3; `Ng1` is scored purely on the resulting
board. `getMaiaMove` then takes the argmax. A history-free policy, played greedily,
over a position pair where each move's inverse is also well-liked, is a 2-cycle
attractor — and both sides fall into it symmetrically.

**Temperature is not the fix.** Measured, since it's the obvious guess:
`sampleFromPolicy` at T = 0.25 and 0.5 draws at 8 plies exactly as argmax does, and
T = 1 merely finds a *different* 2-cycle (`3. Nc3 Nc6 4. Nb1 Nb8`) and draws at 12.
Sampling changes which cycle it lands in, not whether one exists. The cure is a
randomized opening book covering the first K plies, which
`docs/specs/2026-08-05-sprt-engine-ratings.md` specifies for exactly this reason —
its determinism section opens with the same problem in the context of match play.

**Consequences worth knowing:** any Maia-involving self-play measurement over the
standard start position has an effective sample size of one, the rollout work in
Task 14 is unaffected (it samples at T=1 from *many* distinct positions rather than
replaying one line greedily), and a Maia-vs-Maia demo needs a non-standard opening
to be worth watching.

## Gotchas worth knowing (both cost me a build cycle)

- **Next 16 snapshots `web/public/` at build time.** Files added to `web/public/` *after*
  `next build` return 404 from `next start` until you rebuild. Adding ORT's assets
  and re-running without a rebuild produced a confusing "no available backend
  found" error that looked like an ORT problem and wasn't.
- **`onnxruntime-web` needs its `.mjs` glue, not just the `.wasm`.**
  `docs/deployment.md` §4 says to copy its wasm assets into `web/public/`; that's
  necessary but insufficient. It dynamically imports
  `ort-wasm-simd-threaded.jsep.mjs` alongside the `.wasm`, and a missing `.mjs`
  surfaces as `no available backend found` with every backend reporting
  `previous call to 'initWasm()' failed` — which points at the wrong thing.
- **`ort.env.wasm.numThreads = 1`** keeps this single-threaded, so no
  `SharedArrayBuffer` and therefore no COOP/COEP headers — consistent with the
  single-threaded Stockfish decision.

## Still unchecked

- ~~The move table is fetched unpinned.~~ **Fixed.** Both the model and the table
  are now pinned to `e23a50e`
  (`src/hooks/useMaiaEngine/data/all_moves.json`), so they cannot drift apart.
- ~~**`web/public/ort/` is ~38 MB of vendored ORT assets**, because I copied both the
  jsep and non-jsep wasm variants for safety.~~ **Trimmed.** It was 40.4 MB; the
  hunch was right and it's now 26.9 MB, two files. The default
  `onnxruntime-web` import resolves to the **jsep** build, so the jsep `.wasm` +
  `.mjs` are the only ones ever fetched — the plain `.wasm`, plain `.mjs`,
  `asyncify.mjs` and `jspi.mjs` were dead. Confirmed by deleting them and
  re-running `/dev/maia-test`: all checks pass, no console errors. Another
  13.4 MB is there for the taking via a client-side dynamic
  `import("onnxruntime-web/wasm")`; the static version of that import breaks
  `next build`. Details in `docs/deployment.md` §4.
- ~~**No loading state for the 89 MB model.**~~ **Done.** The download now
  streams with a byte/percent readout on both `/model-1v1` and `/user-1v1`
  (`web/components/MaiaLoadNotice.tsx`), a heads-up line before you even press
  Start, and a **stall timeout** — 20 s of zero bytes aborts with a real message
  instead of leaving a permanent thinking lamp. It's a stall timeout rather than
  a total one on purpose: 93 MB is a legitimate ~2.5 minutes on 5 Mbit/s wifi,
  so any total budget generous enough for that is useless for catching a hang.
- **Still no IndexedDB caching of the model, and the HTTP-cache assumption above
  was wrong.** Chrome declines to disk-cache a body that large (the 25 KB move
  table caches fine), so **every full page load re-downloads all 93 MB** —
  measured, not theorised. Within one tab it loads once, via the module-level
  singleton; F5 pays again. That makes the reference app's IndexedDB cache the
  actual fix rather than a nice-to-have, and it's the one piece of this worth
  an hour post-demo. **Now measured on production and it's worse than the local
  numbers suggested: 73 s and 261 s to first move, cold.** The local 23–49 s
  figures didn't include the ~27 MB `ort` wasm, which comes off disk on localhost
  and off the network live — so a real visitor pulls ~120 MB, not 93 MB. See
  `docs/deployment.md` §4 for the demo-day workaround.
- **No `LICENSE` file in the repo**, despite already shipping GPL-3.0 Stockfish.
- The `logits_side_info` output head is unused. Unexamined — it may be Maia 2's
  auxiliary prediction target and might be interesting for a future feature.
