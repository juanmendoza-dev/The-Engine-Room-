# Docs

Two kinds of thing live here, split by folder so you can tell them apart at a
glance:

- **Reference** (this level + `design/`) — how the deployed app actually works.
  Kept current.
- **Process** (`specs/`, `plans/`, `reviews/`, `devlog/`) — the paper trail of
  how it got built. Written before or during the work, and deliberately *not*
  rewritten afterwards, so it records what was believed at the time rather than
  what turned out to be true. Several of them are wrong in interesting ways, and
  say so.

## Start here

| If you want to know… | Read |
| --- | --- |
| what this is and how the pieces fit | the [root README](../README.md) |
| why the app looks the way it does | [`design/ink-and-bone-notes.md`](design/ink-and-bone-notes.md) |
| how Maia actually works in the browser | [`maia-notes.md`](maia-notes.md) |
| how a branch gets to the live site | [`deployment.md`](deployment.md) |
| what was planned vs what shipped | [`plans/2026-08-03-engine-room-implementation.md`](plans/2026-08-03-engine-room-implementation.md) |

## Reference

| File | What's in it |
| --- | --- |
| [`deployment.md`](deployment.md) | Branch workflow, Vercel setup, the KV switch-on runbook, and a long §4 of app-specific things that bite in production — Maia's 93 MB cold load, the ONNX wasm 404 trap, why `curl \| grep` lies about whether a deploy landed, and a pile of headless-Chrome verification traps. The most useful file here. |
| [`rating-notes.md`](rating-notes.md) | What the engine presets are empirically worth, as opposed to what their labels say — measured from played games with a Bradley-Terry fit and a sequential test (Task 16). Read this before quoting "Stockfish 2800" or "Maia 1900" at anyone. Also the runbook for adding a pairing. |
| [`maia-notes.md`](maia-notes.md) | The Maia integration, end to end: why Maia 2 over original Maia and Maia 3 (licensing and encoding), the 18-plane tensor layout, the policy decode, the move table, and the measurements. Moved out of the scripts folder — it's prose, not a script. |
| [`maia-calibration-notes.md`](maia-calibration-notes.md) | Whether Maia's probabilities can be trusted as probabilities, measured against ~4,000 real Lichess rapid moves: reliability diagram, ECE, Brier, log loss, and what the answer means for the live rating estimate's credible interval. Also documents the offline audit scripts and how to re-run them. |
| [`design/ink-and-bone-notes.md`](design/ink-and-bone-notes.md) | The current design system: tokens, fonts, day/night mechanics, the header scoreboard, the brand mark, the route transition, and a Traps section. |
| [`design/fight-fx-notes.md`](design/fight-fx-notes.md) | The 19 fight effects and the tier ladder that decides which one fires on a given move. |
| [`design/hero-notes.md`](design/hero-notes.md) | **Superseded.** The original brass/steam design, replaced on 2026-08-04. Kept for history — don't build from it. |
| `design/*-preview.html` | The approved mockups for both designs. Open directly in a browser; they're self-contained. |

## Process

Rough reading order — each one was written before the work it describes:

| File | Written for |
| --- | --- |
| [`specs/2026-08-03-engine-room-design.md`](specs/2026-08-03-engine-room-design.md) | The approved design: goals, phases, architecture, KV schema, what's out of scope. |
| [`plans/2026-08-03-engine-room-implementation.md`](plans/2026-08-03-engine-room-implementation.md) | Task-by-task build plan, 11 tasks across 4 phases. Each task now carries a "What differed from the original plan" section, which is where the useful content ended up. Its checkboxes are unreliable; the table at the top is the truth. |
| [`reviews/`](reviews/) | Independent review briefs for the two engine spikes. The Maia one reproduces the browser pipeline against CSSLab's training-side preprocessing in Python to check the encoder for real. |
| [`specs/2026-08-05-*.md`](specs/) | Five stretch-goal analysis specs written after Phase 3 landed (Bayesian rating inference, Monte Carlo rollouts, SPRT engine ratings, a policy-mixture engine, a Maia calibration audit), plus `2026-08-05-build-priority.md` saying which order to build them in and why. All five have shipped, and in nearly every case the spec's own numbers were the part that didn't survive — read each one with the plan's matching task section beside it. **Bayesian rating inference → Task 13**: three of its constants were off, two by an order of magnitude in units. **Monte Carlo rollouts → Task 14**: its load-bearing unknown (is the ONNX batch axis dynamic?) turned out fine, but the thing it was banking on — batching being *faster* — was worth about 10%. **Policy-mixture engine → Task 15**: its mate-scoring scheme is broken outright (the synthetic cp saturates the logistic, so every mate ties at exactly 1.0), and its `α:β = 1:1` starting point sits two to three orders of magnitude from where the blend actually balances. **Maia calibration audit → Task 17**: the exception — its method held up as written, and what had rotted was its forward references, since `evaluateMaiaAt` and the rollouts landed in between. It carries a "Refreshed" box at the top saying which, and [`maia-calibration-notes.md`](maia-calibration-notes.md) has the results. **SPRT engine ratings → Task 16**: its maths held up — every hand-worked number in it reproduces — but two of its *procedural* calls didn't survive contact with real games. Treating a draw as connecting two presets under Ford's condition let a 7W-1D-0L pairing report +1680 Elo ± 8279, and sampling openings with replacement put 12 duplicate games into a 66-game log, which was enough to carry one sequential test over its boundary on evidence that didn't exist. [`rating-notes.md`](rating-notes.md) has the ratings and the three findings. All five have now shipped. |
| [`devlog/`](devlog/) | The build's paper trail: the two lane declarations — "I'm claiming these tasks and these files", so parallel agents didn't land on the same code — and the [kickoff prompt](devlog/kickoff-prompt.md) used to bring a fresh agent up to speed on this repo. |

`AGENTS.md` in the repo root is separate from all of this: it's the enforced
rules for agents committing here, not documentation of the app.
