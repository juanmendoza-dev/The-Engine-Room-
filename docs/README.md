# Docs

Two kinds of thing live here, split by folder so you can tell them apart at a
glance:

- **Reference** (this level + `design/`) — how the deployed app actually works.
  Kept current.
- **Process** (`process/`) — the paper trail of how it got built: specs, the
  build plan, lane declarations, code reviews. Written before or during the
  work, and deliberately *not* rewritten afterwards, so it records what was
  believed at the time rather than what turned out to be true. Several of them
  are wrong in interesting ways, and say so.

## Start here

| If you want to know… | Read |
| --- | --- |
| what this is and how the pieces fit | the [root README](../README.md) |
| why the app looks the way it does | [`design/ink-and-bone-notes.md`](design/ink-and-bone-notes.md) |
| how Maia actually works in the browser | [`maia-notes.md`](maia-notes.md) |
| how a branch gets to the live site | [`deployment.md`](deployment.md) |
| what was planned vs what shipped | [`process/plans/2026-08-03-engine-room-implementation.md`](process/plans/2026-08-03-engine-room-implementation.md) |

## Reference

| File | What's in it |
| --- | --- |
| [`deployment.md`](deployment.md) | Branch workflow, Vercel setup, the KV switch-on runbook, and a long §4 of app-specific things that bite in production — Maia's 93 MB cold load, the ONNX wasm 404 trap, why `curl \| grep` lies about whether a deploy landed, and a pile of headless-Chrome verification traps. The most useful file here. |
| [`maia-notes.md`](maia-notes.md) | The Maia integration, end to end: why Maia 2 over original Maia and Maia 3 (licensing and encoding), the 18-plane tensor layout, the policy decode, the move table, and the measurements. Was `scripts/maia-notes.md` — it's prose, not a script. |
| [`design/ink-and-bone-notes.md`](design/ink-and-bone-notes.md) | The current design system: tokens, fonts, day/night mechanics, the header scoreboard, the brand mark, the route transition, and a Traps section. |
| [`design/fight-fx-notes.md`](design/fight-fx-notes.md) | The 19 fight effects and the tier ladder that decides which one fires on a given move. |
| [`design/hero-notes.md`](design/hero-notes.md) | **Superseded.** The original brass/steam design, replaced on 2026-08-04. Kept for history — don't build from it. |
| `design/*-preview.html` | The approved mockups for both designs. Open directly in a browser; they're self-contained. |

## Process

Rough reading order — each one was written before the work it describes:

| File | Written for |
| --- | --- |
| [`process/specs/2026-08-03-engine-room-design.md`](process/specs/2026-08-03-engine-room-design.md) | The approved design: goals, phases, architecture, KV schema, what's out of scope. |
| [`process/plans/2026-08-03-engine-room-implementation.md`](process/plans/2026-08-03-engine-room-implementation.md) | Task-by-task build plan, 11 tasks across 4 phases. Each task now carries a "What differed from the original plan" section, which is where the useful content ended up. Its checkboxes are unreliable; the table at the top is the truth. |
| [`process/work-orders/`](process/work-orders/) | Lane declarations — "I'm claiming these tasks and these files" — so parallel agents didn't land on the same code. |
| [`process/reviews/`](process/reviews/) | Independent review briefs for the two engine spikes. The Maia one reproduces the browser pipeline against CSSLab's training-side preprocessing in Python to check the encoder for real. |
| [`process/specs/2026-08-05-*.md`](process/specs/) | Five stretch-goal analysis specs written after Phase 3 landed (Bayesian rating inference, Monte Carlo rollouts, SPRT engine ratings, a policy-mixture engine, a Maia calibration audit), plus `2026-08-05-build-priority.md` saying which order to build them in and why. Specs only — not all of them will ship. |
| [`process/kickoff-prompt.md`](process/kickoff-prompt.md) | The prompt used to bring a fresh agent up to speed on this repo. |

`AGENTS.md` in the repo root is separate from all of this: it's the enforced
rules for agents committing here, not documentation of the app.
