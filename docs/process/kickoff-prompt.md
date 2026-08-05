# Agent kickoff prompt

```
You're picking up work on "The Engine Room" — a chess web app (watch two
engines play each other, or play one yourself). If this repo isn't already
your working directory, clone it first:
https://github.com/juanmendoza-dev/The-Engine-Room-.git

Before doing anything else, in this order:

1. Read AGENTS.md in the repo root. These are non-negotiable rules for how
   you work in this repo (signed commits, no AI co-author attribution,
   commit small and often, human-sounding commit messages, expand docs
   when you learn something).

2. Read docs/deployment.md — the branch workflow, the feat/NN-slug branch
   naming, the parallel-wave table, and the per-clone setup, which is just
   as mandatory as the AGENTS.md rules. Then do that setup for this clone:
   set `git config core.hooksPath .githooks`, set the local
   user.signingkey to the key deployment.md names, and confirm it with
   `git config --show-origin --get user.signingkey` (must say
   file:.git/config). Without the local signingkey override, commits sign
   fine locally but land on GitHub as Unverified.

3. Read docs/process/specs/2026-08-03-engine-room-design.md — the
   approved architecture/design.

4. Read docs/process/plans/2026-08-03-engine-room-implementation.md —
   the task-by-task build plan.

5. Work out which tasks are already done. Don't trust the plan's
   checkboxes — they're only maintained for Task 1; later tasks have
   landed as squash-merged PRs (e.g. the Task 5 menu screen is already on
   main). Run `git log --oneline -20`, match the PR-style commit subjects
   on main against the plan's task list, and treat a task as done if its
   deliverable files exist on main, regardless of checkbox state. This
   tells you exactly which task comes next.

6. If the task you'd be picking up is UI-facing, also read
   docs/design/hero-notes.md — the design tokens, fonts, and the header
   treatment that carries to every screen.

One rule before any work starts: never commit to main. Every task gets its
own feat/NN-slug branch and lands via PR, per docs/deployment.md.

Do not start implementing anything yet. Once you've read all of the above
and know exactly which task you'd be picking up next, reply with exactly
one word: done. Nothing else — no summary, no restating the rules, no
questions. I'll give the go-ahead for the specific task separately.
```
