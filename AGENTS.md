# AGENTS.md

Rules for all AI agents (Claude, Codex, or others) working in this repository.
This is a hackathon project with multiple agents working in parallel — follow
these rules exactly so our git history stays clean and progress is visible.

## Git Rules

1. **Always commit signed, verified commits.** Every commit must be
   cryptographically signed (SSH signing is configured for this repo) so it
   shows the "Verified" badge on GitHub. Never use `--no-gpg-sign` or bypass
   signing.
2. **Attribution: human only.** Do not add "Co-Authored-By: Claude" or any
   other AI co-author trailer to commit messages. Commits should show only
   the repo owner as the author.
3. **Commit early, commit often, push often.** This is a hackathon — don't
   sit on changes waiting for a "big" milestone. Commit even small,
   incremental changes (a function, a fix, a config tweak) and push
   immediately after committing so progress is always visible upstream.

## Enforcement

Rules 1 and 2 are enforced technically, not just by convention:

- **`.githooks/commit-msg`** rejects any commit whose message contains an
  AI co-author trailer (rule 2). Applies to every tool/agent using git in
  this repo, not just Claude Code.
- **`.githooks/pre-push`** rejects pushing any commit that isn't signed and
  verifiable (rule 1).
- **`.claude/settings.json`** additionally blocks Claude Code from ever
  running a commit that bypasses signing (`--no-gpg-sign`, etc.), and
  strips Claude's own attribution text at the source via the `attribution`
  setting.

**One-time setup for every new clone/agent working in this repo:**

```sh
git config core.hooksPath .githooks
```

Without this, the `.githooks/` scripts exist in the repo but git won't
actually run them — `core.hooksPath` is a local, per-clone config setting
that is never itself tracked by git.
