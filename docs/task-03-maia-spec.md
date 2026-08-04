# Task 3 — Maia ONNX spike: spec

Written before implementation, for review. Nothing in here is built yet.

| | |
| --- | --- |
| Branch | `feat/03-maia-onnx-spike`, off `main` at `5fbc001` |
| Status | **spec only — no implementation** |
| Timebox | 90 minutes of investigation, hard stop |
| Predecessor | Task 2 merged as `5fbc001` (#6). `chess.js` and the `EngineConfig`/`EngineMove` contract are on `main` already |

## Why this is an investigation, not a build

Task 2 could be specified up front because Stockfish speaks UCI — a stable,
documented text protocol. I could write that wrapper before running anything and
be roughly right.

Maia is a different kind of thing. It's a raw Leela Chess Zero–derived neural
network: no protocol, no API, no `bestmove` line. Two problems sit between a FEN
and a move, and **I do not know the answer to either one going in**:

1. **Encoding.** lc0 networks take a stack of 8×8 binary planes — piece
   positions, castling rights, repetition, move history. The plane count and
   their ordering depend on the network format version, and Maia is built on an
   older lc0 format than current nets.
2. **Decoding.** The policy head outputs a score per move, indexed by lc0's own
   move-encoding scheme. That index → move mapping has to be exactly right.

So this spec plans an *investigation with decision gates*, not a known
implementation. Where I don't know something, it says so and says how I'll find
out. The plan doc's instruction is the one I'm following: work it out for real,
checkpoint by checkpoint, don't fabricate it with unverified guesses.

## The trap: for Maia, "returns a legal move" proves nothing

This is the single most important difference from Task 2, and the thing I most
want reviewed.

The decoder's job is: score all moves, keep the ones `chess.js` says are legal,
play the highest-scoring one. Which means **if the encoder is wrong, the output
is still a legal move.** Garbage in the input planes produces a garbage policy
vector, and `argmax` over legal moves still returns something perfectly legal.

Task 2's verification — "chess.js accepted the move" — is therefore *worthless*
as a correctness check here. It would pass just as happily with the planes in
random order.

The failure mode that creates is genuinely bad: a `Maia 1500` option in the
Model 1v1 dropdown that looks like a working feature, plays legal chess, and is
actually noise. That's worse for the project than having no Maia at all, because
nothing surfaces the problem — you'd have to be a strong enough player to notice
the moves are nonsense.

**So the quality bar for this task is:** if I cannot demonstrate the encoder is
correct, I take the fallback and report Maia as unavailable. Shipping an
unvalidated Maia is not an option I'll take on my own judgement.

## Verification design

Four checks, ordered so that each isolates a different failure. The first is the
important one and it needs no ground truth at all.

### T1 — Mirror invariance (tests the encoder, needs no reference data)

lc0 encodes the board **from the perspective of the side to move**: for Black,
the board is flipped and the colours swapped. Getting that wrong is the single
most likely encoder bug, and it's invisible to a legality check.

Take a position `P` with White to move. Build `P'` by mirroring it vertically and
swapping colours, so Black is to move and *sees exactly the same position*. Then:

- `value(P)` ≈ `value(P')`
- the top policy move of `P'` should be the mirror of the top policy move of `P`

This is a pure invariant of a correct encoder. It doesn't require me to know what
Maia "should" say about anything — the network is just required to be consistent
with itself. If T1 fails, the encoder is wrong, full stop.

### T2 — Value-head sanity (tests the encoder independently of the decoder)

The value head is the lever that makes this tractable, because it's completely
independent of the policy-index decoding. If the planes are scrambled, the value
output is nonsense. If the planes are right but my move-index mapping is wrong,
value is fine and only policy is wrong. **That separation is what lets me tell
the two failure modes apart** instead of staring at one wrong move.

- Start position → value ≈ 0 (roughly balanced)
- Side to move up a queen → clearly positive

*Risk I'm flagging now:* Maia's published work is about its policy head. It was
trained with lc0's pipeline, which trains a value head too, so I expect it to be
meaningful — but I haven't confirmed that. If the value head turns out to be weak
or untrained, T2 gets dropped and T1 plus T3 carry the verification. T1 still
works either way, since a mirrored position's *policy* must also match.

### T3 — Policy plausibility (tests the decoder)

Maia is trained to predict what a human of a given rating actually plays. That
gives a real expectation to check against:

- From the start position, Maia 1500's top move should be a normal human opening
  move — `e4`, `d4`, `Nf3`, `c4`. If it's `a3` or `Na3`, the decode is wrong.
- After `1.e4`, Black's top move should be one of the ordinary replies (`e5`,
  `c5`, `e6`, `c6`, `d5`, `Nf6`).

Deliberately a loose band rather than one exact move — Maia is a probability
distribution over human choices, not an oracle, and I'm not going to pretend a
specific move is "the" right answer.

### T4 — Legality (necessary, not sufficient)

The three FENs from the plan (start, mid-opening, king-and-pawn endgame) all
round-trip through `chess.js` as legal. Kept because an illegal move is
definitely a bug — but per the section above, passing this proves nothing on its
own and will not be reported as if it did.

### Decision rules

- T1 fails → encoder is wrong. Debug within the timebox, else fall back.
- T1 passes, T3 fails → encoder fine, decoder wrong. Same rule.
- T1–T3 can't all be made to pass inside 90 minutes → **take the fallback.** Do
  not ship it.

## Checkpoint plan, with the time budget

90 minutes total. Times are the point at which I stop and reassess, not
estimates I expect to hit exactly.

**CP1 — Look for something that already does this (0–15 min).**
Highest-leverage quarter hour in the task. Search npm, GitHub, and HuggingFace
for a browser-runnable Maia or a pre-converted Maia ONNX: `maia chess onnx`,
`lc0 onnx web`, `maia2`. If something exists that takes a FEN and returns a move
in the browser, I skip the whole conversion pipeline and go straight to
verification. Skipping this check to get on with "the real work" would be the
classic mistake — it's the difference between 15 minutes and 90.

**CP2 — Source the weights (15–25 min).**
Maia's weights are published in the CSSLab `maia-chess` repo as `.pb.gz`, one per
rating tier. Fetch the 1500 tier. Record the file size.

**CP3 — Convert to ONNX (25–45 min).**
These are lc0-format weights and lc0 has its own ONNX export path. Get an lc0
binary, then read its actual CLI rather than trusting a remembered flag name —
`lc0 --help`, `lc0 leela2onnx --help` — because the subcommands have changed
across versions. *Gate:* if no working lc0 export path exists by 45 minutes, go
back to hunting a pre-converted file, and if that fails, fall back.

**CP4 — Read the graph's real input/output shapes (45–55 min).**
Netron or `onnxruntime-web` session metadata. I need the exact input tensor shape
(how many planes, in what order) and the output heads (policy length, and whether
value is one scalar or a three-way win/draw/loss). **Everything in CP5 and CP6 is
built against what this step actually reports** — not against remembered lc0
trivia. If the graph and my expectations disagree, the graph wins.

**CP5 — Write the encoder (55–70 min).** FEN → input planes, matching CP4.

**CP6 — Write the decoder (70–80 min).** Policy index → move, filter to
`chess.moves({ verbose: true })`, take the best legal one. No search or minimax
on top — Maia is a policy network trained to imitate humans, not a search engine,
so adding search would actively defeat the point of using it.

**CP7 — Run T1–T4 (80–90 min).**

**At 90 minutes I stop wherever I am**, write up `scripts/maia-notes.md` with what
actually happened, and commit. Reaching CP4 and stopping is a legitimate result,
not a failure — the point of the timebox is that this task can't sink the phase.

## The two outcomes

**Works:** `getMaiaMove(fen, config)` returns real moves, `public/maia/1500.onnx`
is committed, `MAIA_PRESETS` gets populated in Task 4.

**Fallback:** `getMaiaMove` exists with the identical signature but throws
`new Error("Maia not available")`. `MAIA_PRESETS` becomes `[]` in Task 4 and the
Maia options simply don't render. Maia joins the stretch goals.

Either way, **no code outside `lib/chess/engines.ts` changes** — that's exactly
why every later task calls `getMoveFor` and never touches engine internals. And
`scripts/maia-notes.md` gets written in both cases, so a second attempt doesn't
restart from zero.

## Files

**Create / own:**
- `lib/chess/engineMaia.ts` — the wrapper, both outcomes
- `scripts/maia-notes.md` — findings per checkpoint, written either way
- `public/maia/1500.onnx` — only if CP3 succeeds
- `public/ort/` — **only if needed**, see risks below
- `package.json` / `package-lock.json` — adds `onnxruntime-web` if CP3 succeeds

**Won't touch:** every hero file (`app/page.tsx`, `app/layout.tsx`,
`app/globals.css`, `components/*`), anything Vercel or KV (Task 9 stays
unclaimed), `app/model-1v1` / `app/user-1v1`, and `lib/chess/types.ts` — the
contract is published and stays fixed. Task 7 (`Board`) remains unclaimed and
free for another agent.

`.gitattributes` already covers `*.onnx binary` from Task 2, so nothing to add
there.

## Known risks

- **`onnxruntime-web` and its own wasm files.** It loads wasm at runtime and
  doesn't always resolve the paths correctly under a bundler. `deployment.md` §4
  already documents the fix: copy its wasm assets into `public/` and point
  `ort.env.wasm.wasmPaths` at them. That's what `public/ort/` above is for, if it
  comes to it.
- **File size.** Maia is a small network (far smaller than Stockfish's NNUE), so
  I expect a few MB, but I'll check before committing — GitHub rejects over
  100 MB, and per Task 2 the answer is never Git LFS, because Vercel doesn't
  fetch LFS objects during a build.
- **lc0 tooling on Windows.** The export path needs a working lc0 binary. This is
  the most likely place to burn time, hence the CP3 gate.
- **Inference speed.** Maia is one forward pass with no search, so it should be
  fast — but if a move takes seconds in the browser, that affects how watchable
  Model 1v1 is, and Task 6 needs to know. I'll record the measured time.

## One thing I want a decision on

The design doc lists three Maia presets — 1100, 1500, 1900 — but this task only
produces **1500**. So if conversion works, Task 4 either ships one Maia preset
instead of three, or someone converts the other two tiers later.

My recommendation: **if CP3 succeeds and there's time left in the box, convert all
three tiers in the same session.** The pipeline is set up and hot at that point,
so the marginal cost is a couple of minutes per tier, versus a whole second
archaeology session to rediscover the toolchain later. Strictly 1500 first and
fully verified before touching the others, and the timebox still governs.

Flagging it rather than deciding, since it's a scope change against the plan.

## What I will not do

- **Fabricate the encode/decode logic.** If I can't determine the real plane
  layout or move indexing, I say so and take the fallback. A plausible-looking
  guess that yields legal moves is the worst outcome available here.
- **Train or fine-tune anything.** Explicitly out of scope per the spec, now and
  later. This is inference against published weights, nothing else.
- **Add search on top of Maia.** It's a human-imitation policy network; wrapping
  it in minimax would destroy the property that makes it interesting.
- **Report a partial result as a success.** Notes will say which checkpoint I
  reached, and the verification section will say which of T1–T4 actually passed.
