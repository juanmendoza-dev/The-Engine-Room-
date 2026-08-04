# Phase 0 — Engine Spike (work order)

What I'm about to build, so nobody else picks up the same task or edits the
same files underneath me. Written before implementation starts, on 2026-08-04.

**Claimed:** Tasks 2 and 3 of the
[build plan](superpowers/plans/2026-08-03-engine-room-implementation.md) —
the Stockfish.wasm spike and the Maia ONNX spike. That's all of Phase 0.

**Still unclaimed** (free for another agent right now): Task 7, the `Board`
component. It's in the same parallel wave and shares no source files with
either of my tasks — the only overlap is `package.json`.

---

## Where the work happens

| | |
| --- | --- |
| Worktree | `C:\Users\juanm\Desktop\engine-room-phase0` |
| Base | `origin/main` at `88186d8` |
| Task 2 branch | `feat/02-stockfish-spike` |
| Task 3 branch | `feat/03-maia-onnx-spike` |
| This doc's branch | `docs/engine-spike-scope` |

A separate git worktree, not the primary clone. The primary clone at
`C:\Users\juanm\Desktop\The Engine Room` stays parked on `feat/05-hero-menu`
for whoever is taking the hero (PR #4) to production — nothing I do moves its
`HEAD` or touches its working tree.

Both task branches come off `origin/main`, *not* off the hero branch. Nothing
in Phase 0 needs the hero's markup or design tokens, so the hero merging
can't conflict with any of this.

Note for whoever else uses worktrees here: `.claude/worktrees/` is **not** in
`.gitignore`, so a worktree created in the default location shows up as
untracked files in the primary clone — and several of the build plan's commit
steps use `git add -A`. That's why this one lives outside the repo. Adding
`.claude/worktrees/` to `.gitignore` would be a reasonable one-line fix; I
haven't done it because it's outside my two tasks.

---

## Files I create and own

**Task 2 — Stockfish**

- `lib/chess/types.ts` — shared engine types
- `lib/chess/engineStockfish.ts` — the Web Worker / UCI wrapper
- `public/stockfish/` — single-threaded wasm build assets, copied from `node_modules/stockfish`
- `app/dev/stockfish-test/page.tsx` — throwaway verification page, deleted later by Task 8
- `.gitattributes` — appending `*.wasm` / `*.onnx` / `*.nnue` binary rules (see below)
- `package.json` / `package-lock.json` — adds `chess.js`, `stockfish`
- `scripts/cdp-verify.mjs` — **added mid-task, not in the original list.** A
  dependency-free headless-Chrome driver, because `chromium-cli` and Playwright
  turned out not to be installed on this machine and client-side engine code
  can't be verified any other way. Committed rather than left in a temp folder
  so the verification is reproducible by a reviewer.

**Task 3 — Maia**

- `lib/chess/engineMaia.ts` — the ONNX wrapper
- `scripts/maia-notes.md` — what worked and where it stalled, written either way
- `public/maia/1500.onnx` — only if the conversion gets that far
- `package.json` / `package-lock.json` — adds `onnxruntime-web`, if it gets that far

`.gitattributes` currently only has line-ending rules for `.githooks/*` and
`.claude/hooks/*`. `docs/deployment.md` §4 calls for binary rules before any
`.wasm`/`.onnx`/`.nnue` is committed, since git on Windows will happily mangle
a binary it decides is text. Task 2 adds them.

## Files I will not touch

- **The hero agent's:** `app/page.tsx`, `app/layout.tsx`, `app/globals.css`,
  `components/SiteHeader.tsx`, `components/ThemeToggle.tsx`,
  `components/MiniBoard.tsx`. All of PR #4.
- **Anything Vercel or KV:** the Vercel dashboard, Storage/Upstash
  provisioning, `.env.local`, `app/actions/games.ts`. Task 9 stays
  deliberately unclaimed while someone else is in the dashboard doing the
  production deploy — two agents in there at once is how you get a confusing
  half-configured project. Whoever picks up Task 9 later gets a clean run at
  it.
- **`app/model-1v1/page.tsx`** (Task 8) and `app/user-1v1/page.tsx` (Task 10).
  Task 8 in particular wants the hero's design tokens, so it's much cheaper
  after PR #4 lands.
- **The build plan's checkboxes:** I'll tick only Task 2's and Task 3's, each
  inside that task's own PR. Single-line edits, so if the hero agent ticks
  Task 5 at the same time it's a trivial merge at worst.

---

## The contract this produces

This is the part other tasks depend on, so it's fixed before I start. Tasks 4,
6, 8, and 10 all consume it.

```ts
// lib/chess/types.ts
export type EngineType = "stockfish" | "maia" | "human";

export interface EngineConfig {
  type: EngineType;
  label: string;
  elo?: number;         // stockfish only (UCI_Elo)
  ratingTier?: number;  // maia only (1100–1900)
}

export interface EngineMove {
  from: string;
  to: string;
  promotion?: string;
}
```

Both engines expose the identical shape, which is the whole point — the game
loop and both game screens never learn which engine they're talking to:

```ts
getStockfishMove(fen: string, config: EngineConfig): Promise<EngineMove>
getMaiaMove(fen: string, config: EngineConfig): Promise<EngineMove>
```

Task 4 wraps both behind one `getMoveFor(fen, config)`. Nothing downstream
imports either engine file directly.

## Two possible endings for Task 3

Maia is not Stockfish. Stockfish speaks UCI, a stable documented text
protocol. Maia is a raw lc0-derived neural net — the board has to be encoded
into lc0's input planes and the policy output decoded back into a move, and
neither of those is a solved problem going in. So Task 3 is a **90-minute
timeboxed investigation** with seven checkpoints, not a task with a
guaranteed output.

**If it works:** `getMaiaMove` returns real moves, `public/maia/1500.onnx`
exists, `MAIA_PRESETS` in Task 4 gets its three tiers.

**If the timebox runs out:** `getMaiaMove` still exists with the exact
signature above, but its body throws `new Error("Maia not available")`.
`MAIA_PRESETS` becomes `[]` in Task 4 and the Maia dropdown options simply
don't render. Maia joins the stretch goals.

Both are correct outcomes — the fallback is the plan working as designed, and
it's why every later task talks to `getMoveFor` instead of Maia internals. No
code outside `lib/chess/engines.ts` changes either way. `scripts/maia-notes.md`
gets written in both cases so the next attempt doesn't start from zero.

---

## How this gets verified

No automated tests — the spec is explicit that this MVP has no test suite and
every task verifies by hand.

- **Task 2:** `npm run dev`, open `/dev/stockfish-test`, confirm it prints a
  legal move rather than an error or `ILLEGAL move returned`. Then
  `npm run build`, because that's what Vercel actually runs and it catches
  TS/lint failures the dev server won't.
- **Task 3:** three known FENs (start position, mid-opening, king-and-pawn
  endgame) all round-trip through `chess.js` as `LEGAL`.

## Where the plan's code snippets are wrong, and why that's expected

The build plan writes Task 2 with placeholder values it flags as guesses.
Correcting these is not a design change — noting them so the diff doesn't read
as freelancing:

- The worker path is hardcoded as `/stockfish/stockfish-single.js`. The real
  filename depends on the installed `stockfish` package version and gets read
  off `node_modules/stockfish`.
- Whether that build loads as a plain `new Worker()` or needs
  `{ type: "module" }` has to be checked, not assumed.
- NNUE-flavoured builds fetch their weights file at runtime, relative to the
  worker script. If that path is wrong the engine loads and then silently
  fails to produce a move.
- The plan waits only for `uciok`. Adding an `isready` / `readyok` handshake
  before `go` is the robust ordering.
- `go movetime 500` is ~500 ms per move, so a full auto-played game is
  roughly 40 s. Fine, but Task 6 should know that number when it picks its
  inter-move delay.

## Coordination

- **`package-lock.json` is the one real conflict risk.** I'm adding
  `chess.js` and `stockfish`, plus `onnxruntime-web` if Task 3 gets there.
  Don't hand-merge it — `docs/deployment.md` §1 has the regenerate protocol
  (take `main`'s copy, re-run `npm install` for your branch's package).
- **Check binary sizes before `git add`.** Some Stockfish NNUE wasm builds are
  large; GitHub warns at 50 MB and rejects at 100 MB. If a build is too big
  the fix is a smaller build, not Git LFS — Vercel doesn't fetch LFS objects
  during a build, so LFS-tracked static assets arrive as pointer text and
  break at runtime while working fine locally.
- **Preview builds queue.** Hobby plan runs one build at a time, so my preview
  deploys may sit behind the production deploy. A queued build isn't a hung
  one.
- **No COOP/COEP headers.** The single-threaded build is a deliberate choice
  to avoid `SharedArrayBuffer`, so `next.config.ts` needs no custom headers.
  That changes only if someone swaps in the multi-threaded build.

## Where I stop

End of Task 3 is the Phase 0 check-in gate, so I stop there and report rather
than rolling into Task 4.

Merging isn't gated, though — per `docs/deployment.md`, phase boundaries are
check-in gates, not merge gates. Task 2 opens its PR and merges as soon as
it's verified, and Task 3 does the same. Tasks 4, 6, and 7 stay unclaimed by
me.

## Status

- **Task 2 — done**, commit `54f050d`. Three positions at ELO 1320/1800/2800 all
  return chess.js-legal moves, verified in headless Chrome. One correction worth
  carrying forward: the build we use is the **lite** single-threaded one, because
  the plain single-threaded wasm is 107.8 MB and GitHub rejects anything over
  100 MB. Task 2's "What differed" section in the build plan has the full list.
  **Held unmerged pending agent review** — see
  [`task-02-stockfish-review.md`](task-02-stockfish-review.md) for the review
  brief: every decision and why, how to reproduce the verification, and the soft
  spots worth attacking.
- **Task 3 — not started.**

Updated as each lands.
