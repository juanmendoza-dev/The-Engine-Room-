# Task 3 — Maia ONNX spike: spec

Written before implementation, for review. Nothing in here is built yet.

| | |
| --- | --- |
| Branch | `feat/03-maia-onnx-spike`, off `main` at `5fbc001` |
| Status | **approved to execute** — review corrections applied, no implementation yet |
| Timebox | 90 minutes of investigation, hard stop |
| Predecessor | Task 2 merged as `5fbc001` (#6). `chess.js` and the `EngineConfig`/`EngineMove` contract are on `main` already |

## Corrections applied after review

Approved to execute with three corrections and one decision, all in the
verification design — the checkpoint plan, timebox, scope and fallback rules were
accepted as written. What changed:

1. **V4 (mirror invariance) demoted from primary, and its section rewritten.** The
   original made it load-bearing, which was wrong: lc0's black-to-move encoding
   *is* a rank-flip plus colour-swap, so a test that mirrors `P` with the same
   logic the encoder uses produces `encode(P') == encode(P)` **by construction** —
   testing that flip∘flip is the identity, not that the encoding is correct. It
   also passes under any consistently-applied bug, since a uniform error cancels
   on both sides. It now says what it really catches (whether perspective handling
   happens at all), and the mirrored FEN is built independently of the encoder's
   own flip path so the construction can't be self-confirming.
2. **Added V1 — lc0 parity, now the primary check.** lc0 is already needed at CP3,
   and it can run the same Maia weights and report per-move policy and value. So my
   pipeline's output gets compared against the reference implementation of the same
   computation. This is the only check that catches a *consistently* wrong encoder,
   which is precisely the class of bug every other check here lets through. Knock-on
   effect: lc0 is now load-bearing for verification, not just conversion, so "no
   lc0" became a fallback condition and CP3's gate got harder.
3. **History planes now addressed explicitly** — see the section below. The
   contract hands the wrapper a bare FEN while lc0-format nets expect history
   planes, so they must be synthesized, and the choice changes the output. Decided:
   repeat the current position, matching whatever lc0 does for a FEN-only position,
   because V1 is only meaningful if both sides are fed the same thing. The caveat
   about synthesized history goes in `maia-notes.md`.
4. **Rating tiers decided** rather than left open — see "Rating tiers" below.

The three corrections interlock in a way worth noting: V1 is what closes the hole
that demoting V4 opens, and V1 is *also* what settles the history-plane question,
since matching lc0 derives the right convention instead of guessing it.

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

V1 below is the mechanism for demonstrating it — comparison against lc0 running the
same weights. Everything else in the verification list either narrows down where a
failure lives or catches one specific bug.

## History planes: the interface forces a choice

lc0-format networks don't just encode the current position — they include
**move-history planes**, several previous positions stacked alongside the current
one. But the published contract is `getMaiaMove(fen, config)`: a bare FEN, with no
history attached. So the history planes have to be synthesized, and the choice
measurably changes the policy output. It isn't a detail I can leave undecided.

**The two options** are zero-filled history planes, or repeating the current
position into them.

**Decision: repeat the current position**, for two reasons.

1. Zeroed planes encode "no pieces anywhere" for the previous positions — a board
   state the network never saw during training. That's off-distribution input, and
   the output is correspondingly meaningless. A repeated current position is at
   least a legal, in-distribution board.
2. More decisively: **V1 requires it.** Matching lc0's output is only meaningful if
   lc0 and my pipeline are fed the same thing — and lc0, handed a bare
   `position fen` with no move list, faces exactly this same problem and resolves
   it with its own history-fill behaviour. So the correct convention isn't
   something I need to guess: it's whatever lc0 does, and V1 is what confirms I've
   matched it.

lc0 exposes a setting that governs this. I'll read its real name and default off
`lc0 --help` and the engine's advertised UCI options at CP3 rather than trusting a
remembered name, and adopt lc0's behaviour for a FEN-only position. If that turns
out to be zero-fill rather than repeat, I match lc0 anyway and record the change —
V1 outranks my prior here.

**To record in `docs/maia-notes.md` either way:** Maia's published results
assume *real* game history, so with synthesized history the move quality may
differ slightly from the published behaviour. That's a caveat on the feature, not
a bug, and it should be written down rather than discovered later by someone
wondering why Maia plays a bit oddly.

**Noted, not built:** the wrapper could later accept optional recent FENs to fill
real history — the game loop has them, so it's cheap to add when something needs
it. Out of scope now; recording the seam so it isn't a surprise.

## Verification design

Five checks, in strict order of how much they actually prove. Only the first is
load-bearing; the rest narrow down *where* a failure is, or catch specific bugs.

### V1 — lc0 parity against the same weights (primary)

**This is the check the task rests on.** lc0 is the reference implementation for
lc0-format networks. It can load the exact same Maia 1500 weights and report, per
position, its policy scores per move and its value — via its verbose move-stats
output. So:

> Run each test position through lc0-with-Maia-1500, and require my ONNX
> pipeline's top policy moves and value to match lc0's.

This is the only check that can catch a **consistently wrong** encoder. Every
other check here can be satisfied by a bug that's applied uniformly, because the
network stays self-consistent and the outputs stay plausible. Comparing against an
independent implementation of the same computation is what makes the failure loud
instead of silent.

Practical notes for when I do it: read the actual flag and UCI-option names off
`lc0 --help` and the engine's advertised option list rather than trusting
remembered ones, and use a node count of 1 so what's reported is the raw network
policy rather than a search-adjusted distribution.

**This makes lc0 load-bearing for verification, not just conversion.** Which
changes the CP3 gate: if I can't get a working lc0, I don't just lose the
conversion route, I lose ground truth. Two branches:

- **No lc0 at all** → V1 is impossible → **take the fallback.** V2–V5 cannot
  establish correctness on their own, and per the quality bar above I won't ship
  an unvalidated encoder.
- **CP1 found a turnkey package** → I'm not writing the encoder, so there's no
  encoder of mine to validate. V1's role shifts to validating the *integration*:
  spot-check against lc0 if it's available, and otherwise lean on V3 and V5 while
  recording plainly that no reference comparison was performed.

### V2 — Value-head sanity (isolates encoder from decoder)

Useful because it's independent of the policy-index decoding, so it splits the two
failure modes apart: scrambled planes give a bad value, while bad move indexing
gives a good value with bad policy. Without that split, a wrong move tells me
nothing about which half is broken.

- Start position → value ≈ 0 (roughly balanced)
- Side to move up a queen → clearly positive

*Risk flagged:* Maia's published work is about its policy head. It was trained
with lc0's pipeline, which trains a value head too, so I expect it to be
meaningful — but I haven't confirmed it. If the value head turns out weak or
untrained, V2 gets dropped; V1 doesn't depend on it, and V1 is what matters.

### V3 — Policy plausibility (sanity band on the decoder)

Maia predicts what a human of a given rating actually plays, which gives a real
expectation:

- From the start position, Maia 1500's top move should be a normal human opening
  move — `e4`, `d4`, `Nf3`, `c4`. If it's `a3` or `Na3`, something is wrong.
- After `1.e4`, Black's top move should be an ordinary reply (`e5`, `c5`, `e6`,
  `c6`, `d5`, `Nf6`).

Deliberately a loose band, not one exact move — Maia is a distribution over human
choices, not an oracle. Note this is weaker than V1: a subtly wrong pipeline can
still land inside the band by luck, since a handful of moves dominate the policy
from the opening position.

### V4 — Mirror invariance (weak: a failure is definitive, a pass proves little)

Originally written as the primary check. That was wrong, and the reason is worth
recording because the mistake is seductive.

lc0's own black-to-move encoding **is** a rank-flip plus colour-swap. So if my
test constructs `P'` from `P` using the same mirror logic my encoder uses, then my
encoder's flip cancels my test's flip and `encode(P')` comes out **byte-identical
to `encode(P)`** — by construction. The network then "agrees with itself"
trivially, and I've tested that flip∘flip is the identity, not that the encoding
is right.

It's also blind to any bug applied identically to both sides: a consistently
scrambled plane order cancels out and passes.

What it does still catch, which is worth having: **whether perspective handling is
applied at all.** If I forget to flip for Black entirely, `encode(P')` genuinely
differs from `encode(P)` and the outputs diverge. So a V4 failure is definitive
and immediately informative. A V4 pass means almost nothing on its own.

To avoid the self-confirming construction, the mirrored FEN gets built
independently of the encoder's own flip path — as a literal FEN string, not by
calling the encoder's helper.

### V5 — Legality (necessary, not sufficient)

The three FENs from the plan (start, mid-opening, king-and-pawn endgame) all
round-trip through `chess.js` as legal. An illegal move is definitely a bug, but
per the trap section above, passing this proves nothing and won't be reported as
if it did.

### Decision rules

- **V1 fails → do not ship.** Debug inside the timebox, else fall back.
- **V1 unavailable (no lc0) → fall back.** Stated above; the primary check not
  being possible is itself a fallback condition.
- V4 fails → perspective handling is missing or broken. Definitive, fix it first.
- V1 passes but V3 fails → suspect the move-index decoding, since V1 covers both
  halves and V3 only reads the decoded end.
- Can't get V1 plus V2/V3 to pass inside 90 minutes → **take the fallback.**

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

**CP3 — Convert to ONNX, and capture ground truth while lc0 is up (25–45 min).**
Three things, in this order, because lc0 is needed for all of them and setting it
up twice would be waste:

1. **Convert.** These are lc0-format weights and lc0 has its own ONNX export path.
   Get an lc0 binary, then read its actual CLI rather than trusting a remembered
   flag name — `lc0 --help`, `lc0 leela2onnx --help` — because the subcommands
   have changed across versions.
2. **Capture the V1 reference.** With lc0 loaded with the Maia 1500 weights, run
   every test FEN through it at one node with verbose move stats on, and save the
   per-move policy scores and value. This is the ground truth V1 compares
   against, and it has to be captured now — going back for it later means
   rebuilding the whole lc0 setup.
3. **Read the history-fill default.** Find the real option name and its default
   from `lc0 --help` / the advertised UCI options, since that's what determines
   the history-plane convention my encoder has to match.

*Gate:* if no working lc0 export path exists by 45 minutes, go back to hunting a
pre-converted file. But note that **no lc0 also means no V1**, which per the
verification rules is itself a fallback condition — so this gate is harder than it
was in the first draft of this spec.

**CP4 — Read the graph's real input/output shapes (45–52 min).**
Netron or `onnxruntime-web` session metadata. I need the exact input tensor shape
(how many planes, in what order) and the output heads (policy length, and whether
value is one scalar or a three-way win/draw/loss). **Everything in CP5 and CP6 is
built against what this step actually reports** — not against remembered lc0
trivia. If the graph and my expectations disagree, the graph wins.

**CP5 — Write the encoder (52–68 min).** FEN → input planes, matching CP4's
reported shape, with history planes filled per the convention decided above.

**CP6 — Write the decoder (68–78 min).** Policy index → move, filter to
`chess.moves({ verbose: true })`, take the best legal one. No search or minimax
on top — Maia is a policy network trained to imitate humans, not a search engine,
so adding search would actively defeat the point of using it.

**CP7 — Run V1–V5 (78–90 min).** V1 first: it's the one that decides whether this
ships, and if it fails the others only tell me where to look.

**At 90 minutes I stop wherever I am**, write up `docs/maia-notes.md` with what
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
`docs/maia-notes.md` gets written in both cases, so a second attempt doesn't
restart from zero.

## Files

**Create / own:**
- `lib/chess/engineMaia.ts` — the wrapper, both outcomes
- `docs/maia-notes.md` — findings per checkpoint, written either way
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
- **lc0 tooling on Windows — now the biggest single risk.** A working lc0 binary is
  needed twice over: to export the ONNX, and to produce V1's ground truth. Since V1
  is the check that decides whether this ships, no lc0 means no Maia — a
  pre-converted ONNX found elsewhere would get me a model but still leave the
  pipeline unvalidated. This is the most likely place to burn time, hence the
  hardened CP3 gate.
- **Inference speed.** Maia is one forward pass with no search, so it should be
  fast — but if a move takes seconds in the browser, that affects how watchable
  Model 1v1 is, and Task 6 needs to know. I'll record the measured time.

## Rating tiers — decided

The design doc lists three Maia presets (1100 / 1500 / 1900) but this task only
produces **1500**, so Task 4 would otherwise ship one preset instead of three.

**Approved at review, as recommended:** if CP3 succeeds and the timebox allows,
convert 1100 and 1900 in the same session, since the pipeline is hot at that point
and the marginal cost is minutes versus a whole second session to rediscover the
toolchain. Conditions, all binding:

- **1500 first, and fully verified** (V1 passing) before touching the other tiers.
- **The timebox still governs.** Ship one preset rather than blow the box — a
  verified 1500 beats three unverified tiers.

Note that adding a tier is a weights swap, not new logic: same graph shape, same
encoder, same decoder. So once 1500 is verified, the others are cheap and low-risk.
If only 1500 lands, `MAIA_PRESETS` in Task 4 carries one entry and the other two
stay on the stretch list with the toolchain now documented.

## What I will not do

- **Fabricate the encode/decode logic.** If I can't determine the real plane
  layout or move indexing, I say so and take the fallback. A plausible-looking
  guess that yields legal moves is the worst outcome available here.
- **Train or fine-tune anything.** Explicitly out of scope per the spec, now and
  later. This is inference against published weights, nothing else.
- **Add search on top of Maia.** It's a human-imitation policy network; wrapping
  it in minimax would destroy the property that makes it interesting.
- **Report a partial result as a success.** Notes will say which checkpoint I
  reached, and the verification section will say which of V1–V5 actually passed —
  including, explicitly, if V1 was never run because lc0 couldn't be obtained.
