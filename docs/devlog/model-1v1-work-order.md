# Model 1v1 — work order

Written 2026-08-04, in the same spirit as
[`phase-0-engine-spike.md`](phase-0-engine-spike.md): declare the lane before
building so two agents don't land on the same files.

**Claimed:** Tasks 7, 4, 6 and 8 of the
[build plan](../plans/2026-08-03-engine-room-implementation.md) — the
`Board` component, the engine registry, the game loop, and the Model 1v1 screen.
Together those four *are* a working Model 1v1, which is the fastest route to
something demoable.

All four were explicitly left unclaimed by the Phase 0 work order, and Task 2
(Stockfish) is already merged on `main` — so this builds on a real engine, not a
stub.

## Why this order, and why not wait for Maia

Task 3 (Maia) is **spec-only** as of PR #7 and is a 90-minute timeboxed
investigation with a documented "may not land at all" ending. Model 1v1 does not
need it: Stockfish 1320 vs 2800 is a genuinely watchable game today. So Maia is
decoupled entirely rather than sequenced ahead of the demo.

Task 9 (KV persistence) is also deliberately *not* in this lane. It needs Vercel
dashboard provisioning, the Phase 0 work order parked it while someone else was in
the dashboard, and nothing about watching two engines play requires a database.
The `saveGame` call sits commented in `web/app/model-1v1/page.tsx` exactly where the
build plan says to leave it.

## Files I create and own

- `web/components/Board.tsx` — react-chessboard wrapper (Task 7)
- `web/components/EngineConfigPicker.tsx` — preset dropdown (Task 8)
- `web/components/ResultScreen.tsx` — end-of-game summary (Task 8)
- `web/lib/chess/engines.ts` — presets + `getMoveFor` (Task 4)
- `web/lib/chess/gameLoop.ts` — `runModelGame` (Task 6)
- `web/app/model-1v1/page.tsx` — the screen (Task 8)
- `web/scripts/cdp-model-1v1.mjs` — headless driver that can *click*, since
  `cdp-verify.mjs` only polls page text
- `package.json` / `package-lock.json` — adds `react-chessboard`

## Files I do not touch

- `web/lib/chess/engineStockfish.ts`, `web/lib/chess/types.ts`, `web/public/stockfish/` — Task
  2's, already merged. I consume them unchanged.
- `web/lib/chess/engineMaia.ts`, `docs/maia-notes.md`, `web/public/maia/` — Task 3's,
  not mine, and not imported (see below).
- `web/scripts/cdp-verify.mjs` — Task 2's harness. I wrote a sibling instead of adding
  a click hook to it.
- `web/app/dev/stockfish-test/` — the build plan has Task 8 delete this. **I've left it
  in place**: it's the manual entry point for verifying the engine my code depends
  on, and Task 3 is still in flight. Cheap to delete later; actively useful now.
- Anything Vercel/KV: `web/app/actions/games.ts`, `.env.local`, the dashboard.
- `web/app/user-1v1/page.tsx` (Task 10), `web/app/history/page.tsx` (Task 11).

## The Maia insertion point

`web/lib/chess/engines.ts` has `MAIA_PRESETS: EngineConfig[] = []` and does **not**
import `./engineMaia`. That's not laziness — a static import of a module that
doesn't exist fails the build, so the build plan's Task 4 snippet cannot compile
as written until Task 3 lands.

Whoever finishes Task 3 makes a three-line change, in one file, and nothing else
in the app moves:

1. `import { getMaiaMove } from "./engineMaia";`
2. fill `MAIA_PRESETS` with the tiers that actually verified
3. add the `config.type === "maia"` branch to `getMoveFor`

The comment in that file says the same thing at the site.

## Corrections to the build plan applied here

The plan's Task 6/7 snippets predate the installed library versions. Flagging
these so the diff doesn't read as freelancing — each is recorded in the plan's own
task section too:

1. **`react-chessboard` v5 moved every prop into an `options` object** and renamed
   `arePiecesDraggable` → `allowDragging`. The plan's Task 7 snippet is v4 and does
   not compile. The plan did warn to check this.
2. **chess.js 1.x `move()` throws on an illegal move**; it does not return `null`.
   So the plan's `if (!applied)` defensive branch is dead code — an engine
   returning a bad move would have thrown and killed the loop instead of falling
   back to a random legal move. Now a `try`/`catch`, which is what the spec's
   error-handling section actually asks for.
3. **The game loop needs cancellation.** The plan's `runModelGame` runs to
   completion unconditionally. Leaving the page mid-game left the loop running and
   the single shared engine worker busy. It now takes an `AbortSignal`, and the
   page aborts on unmount and on rematch.
4. **Inter-move delay lowered from 600ms to 350ms.** Task 2 exports
   `MOVE_TIME_MS = 500` and its own notes flag that the loop should account for it:
   500 + 600 was making a full game drag well past two minutes for no benefit.

## How this gets verified

No automated suite, per the spec — manual verification, but driven headlessly so
it's reproducible:

```sh
npm run dev

"/c/Program Files/Google/Chrome/Application/chrome.exe" \
  --headless=new --remote-debugging-port=9222 \
  --user-data-dir=/tmp/cdp-profile about:blank &

node web/scripts/cdp-model-1v1.mjs http://127.0.0.1:3000/model-1v1 300 300000 9222
```

**Use `127.0.0.1`, not `localhost`.** This Chrome refuses to navigate to
`http://localhost:3000` — the tab just stays on `about:blank`, no console error,
no CDP error, and `Page.navigate` even returns a normal-looking success result.
The dev server is bound to both stacks and `curl` reaches it either way, so the
give-away is the dev server logging no request at all. Cost me a false FAIL that
looked like a UI bug. Chrome's own log showed
`Network service crashed or was terminated, restarting service` around the same
time, so that may be the underlying cause rather than name resolution — either
way, the IPv4 literal is reliable.

Second trap: **the script's exit code came back 0 on a failed run** when
backgrounded, while its own output said `FAIL`. Read the output, don't trust the
exit code.

The driver clicks "Start game", watches the ply counter climb, and reports the
move log, the result if the game finishes, and any console error or uncaught
exception. Exit code 0 only if it clicked and reached the ply floor.

Plus `npm run build` (what Vercel runs) and `npx eslint .`.
