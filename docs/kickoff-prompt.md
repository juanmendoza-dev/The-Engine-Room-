# Agent kickoff prompt

Copy-paste this at the start of every new agent session working on this
project (any tool — Claude Code, Codex, etc.).

```
You're picking up work on "The Engine Room" — a chess web app (watch two
engines play each other, or play one yourself). If this repo isn't already
your working directory, clone it first:
https://github.com/juanmendoza-dev/The-Engine-Room-.git

Before doing anything else, in this order:

1. Read AGENTS.md in the repo root. These are non-negotiable rules for how
   you work in this repo (signed commits, no AI co-author attribution,
   commit small and often, human-sounding commit messages, expand docs
   when you learn something). Confirm core.hooksPath is set for this
   clone: `git config core.hooksPath .githooks` (one-time per clone).

2. Read docs/superpowers/specs/2026-08-03-engine-room-design.md — the
   approved architecture/design.

3. Read docs/superpowers/plans/2026-08-03-engine-room-implementation.md —
   the task-by-task build plan.

4. Run `git log --oneline -20` and check which tasks in the plan are
   already checked off (`- [x]`) vs not (`- [ ]`). Git history is the
   ground truth if the two ever disagree. This tells you exactly which
   task comes next.

Do not start implementing anything yet. Once you've read all of the above
and know exactly which task you'd be picking up next, reply with exactly
one word: done. Nothing else — no summary, no restating the rules, no
questions. I'll give the go-ahead for the specific task separately.
```
