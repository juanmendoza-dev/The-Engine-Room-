# Task 2 — Stockfish spike: review brief

For whoever reviews PR #6. What changed, why each decision went the way it did,
how to re-verify it independently, and what I'd attack hardest if I were the
reviewer rather than the author.

| | |
| --- | --- |
| PR | #6, **not merged** — held for review |
| Branch | `feat/02-stockfish-spike`, off `main` at `800bcb9` |
| Commits | `54f050d` (the engine work), `f48eeb1` (plan + status docs), plus this doc |
| Verified | locally, dev **and** production build, headless Chrome. Vercel build check green. Vercel *preview* not verifiable — see "Deployment Protection" below |

## Read these first, so you're not reviewing cold

- `docs/phase-0-engine-spike.md` — the work order I wrote **before** touching
  code: scope, which files I claimed, which I promised not to touch, and the
  engine contract. Merged as #5. Reviewing against this is the point: it's the
  thing I said I'd do, so any drift is visible.
- Task 2 in `docs/superpowers/plans/2026-08-03-engine-room-implementation.md` —
  step-by-step, with a "What differed from the original plan" section.
- `docs/deployment.md` §4 — the binary-asset and Vercel traps this task had to
  respect. Two of them were live hazards here, not hypotheticals.

## What changed, file by file

| File | What it is | Why it looks like that |
| --- | --- | --- |
| `lib/chess/types.ts` | `EngineType`, `EngineConfig`, `EngineMove` | Verbatim from the spec's contract. Tasks 4/6/8/10 all import these, so it's the one file that shouldn't drift. |
| `lib/chess/engineStockfish.ts` | Worker + UCI wrapper, `getStockfishMove(fen, config)` | The substance of the review. Diverges from the plan's draft in four places, each called out below. |
| `public/stockfish/stockfish-18-lite-single.js` | 21 KB Emscripten loader | Copied unmodified from `node_modules/stockfish/bin/`. |
| `public/stockfish/stockfish-18-lite-single.wasm` | 7.0 MB engine | Same. Must sit beside the `.js` — Emscripten resolves it relative to the script. |
| `app/dev/stockfish-test/page.tsx` | Scratch verification page | Throwaway; Task 8 deletes it. Three positions at three ELOs with timings, not the plan's single position. |
| `.gitattributes` | `*.wasm` / `*.onnx` / `*.nnue` binary | Was missing. On Windows git will rewrite line endings inside a binary and corrupt it silently. |
| `scripts/cdp-verify.mjs` | Headless-Chrome driver | **Addition to my declared file list** — see "Scope" below. `.mjs` not `.js`: it uses top-level `await`, and in a package without `"type": "module"` the extension is what makes that unambiguous to both Node and ESLint. |
| `package.json` / `package-lock.json` | `chess.js`, `stockfish` | The known conflict hotspot. |

## Decisions to check

### 1. The build flavour — the one that actually matters

The plan said "single-threaded". I used **lite** single-threaded. Not a
preference:

| File | Size | Why not |
| --- | --- | --- |
| `stockfish-18.wasm` | 107.8 MB | multi-threaded, needs COOP/COEP |
| `stockfish-18-single.wasm` | 107.8 MB | **GitHub hard-rejects >100 MB** |
| `stockfish-18-lite.wasm` | 6.8 MB | multi-threaded, needs COOP/COEP |
| `stockfish-18-lite-single.wasm` | 7.0 MB | ✅ used |

Git LFS is not the escape hatch, and this is the part worth understanding:
Vercel doesn't fetch LFS objects during a build, so an LFS-tracked wasm arrives
as pointer text and breaks **only in production**, while working perfectly
locally. `docs/deployment.md` §4 already warned about this.

Cost of the choice: a weaker net. Why it's acceptable — we drive the engine with
`UCI_LimitStrength=true` and cap `UCI_Elo` at 2800, so the full net's extra
strength is thrown away regardless, and the package's own README recommends
lite-single as the default for browser use.

**If you disagree**, the alternative is hosting the 107 MB wasm off-repo
(Vercel Blob or similar) and fetching at runtime. That's a real option but it
adds a network dependency, a cold-start cost, and a storage integration to a
zero-budget hackathon build. I judged that a bad trade; say so if you'd rather
have the stronger net.

### 2. `isready` / `readyok` before `go`

The plan waited only for `uciok` at startup. That confirms the engine parsed
`uci` — it does **not** confirm that the `UCI_LimitStrength` and `UCI_Elo`
options set immediately before `go` have been applied. UCI's answer to that is
`isready` → `readyok`, so that handshake is now in the hot path per move.

Concretely: without it, the ELO setting can be raced by the search starting, and
the first move of a game might come from an unrestricted engine.

### 3. Requests are serialized through a promise queue

There's one shared `Worker` and replies are matched by listening for the next
line that fits (`readyok`, `bestmove …`). Two overlapping `getStockfishMove`
calls on one worker would therefore resolve **each other's** promises and hand
back the wrong move.

The game loop awaits each move, so this can't fire today. It's four lines to
make the module safe for any caller, including a future one that doesn't await —
and it's the sort of bug that presents as "the engine occasionally plays a move
from the wrong position", which is miserable to track down later.

### 4. Load failures and silent engines reject instead of hanging

The plan's draft had no error path: a worker that 404s, or an engine that stops
talking, left the promise pending forever. Both now reject with a real message.
That's what makes the design doc's "Engine failed to load, refresh" inline error
possible at all.

Timeout is 60 s, deliberately generous — it covers a cold-cache fetch of a 7 MB
wasm on a slow connection. It exists to turn a hang into an error, not to
enforce anything about speed.

### 5. `.gitattributes`

Confirm the wasm actually landed as binary: `git show --stat 54f050d` should
report the `.wasm` as `Bin 0 -> 7295411 bytes`, not a line count.

## How to re-verify from scratch

Don't take the numbers below on trust — this reproduces them in about three
minutes.

```sh
git fetch origin && git switch feat/02-stockfish-spike
npm install
npm run build          # what Vercel runs; catches TS/lint the dev server won't
npm run start          # production build, closer to Vercel than `npm run dev`
```

Then either open `http://localhost:3000/dev/stockfish-test` in a browser, or
drive it headlessly — `chromium-cli` and Playwright aren't installed on this
machine, but Chrome is, and `scripts/cdp-verify.mjs` needs no dependencies at all
(Node 22+ has `fetch` and `WebSocket` built in):

```sh
"/c/Program Files/Google/Chrome/Application/chrome.exe" \
  --headless=new --remote-debugging-port=9222 \
  --user-data-dir=/tmp/cdp-profile about:blank &

node scripts/cdp-verify.mjs http://localhost:3000/dev/stockfish-test done 150000 9222
```

It prints the page text plus any `Runtime.exceptionThrown` / console errors, and
exits non-zero if the page never finished. What I got, production build:

```
LEGAL    elo 1320  start position         e2e3 (e3)     867ms
LEGAL    elo 1800  mid-opening            d2d4 (d4)     510ms
LEGAL    elo 2800  king + pawn endgame    e3f3 (Kf3)    506ms
```

Two things to read off that, beyond "it's legal":

- **The timings.** Everything after the first call lands within a few ms of
  `movetime 500`. If a move came back in 5 ms the engine wouldn't be searching
  at all, and "returns a legal move" would be worth very little — a random legal
  move also satisfies that.
- **The moves differ run to run** at the same ELO (the dev-server run played
  `d2d4`/`Kd3` where production played `e2e3`/`Kf3`). That's `UCI_LimitStrength`
  actually perturbing play. Identical moves every run would suggest the ELO
  options were being ignored.

`ILLEGAL` in that output would mean chess.js rejected the engine's move —
whether the encoding is wrong or the engine is confused, chess.js is
authoritative per the spec, and that's a fail.

## What I'd challenge if I were reviewing this

Written by the author, so weight it accordingly — but these are the real soft
spots, not decorative ones:

1. **`config.elo ?? 1500` silently defaults.** A caller that forgets `elo` gets a
   1500-rated engine instead of an error. Defensible for a spike; arguably it
   should throw, since a silently-wrong difficulty is worse than a crash. Easy
   change if you want it.
2. **No `UCI_Elo` range validation.** Stockfish 18 accepts roughly 1320–3190 and
   quietly clamps outside that. Passing `elo: 400` would look like it worked. All
   three presets are in range, so nothing is broken today.
3. **The worker is never terminated.** It lives for the page's lifetime. That's
   deliberate — you don't want to re-fetch 7 MB when switching game modes — but
   there's no teardown path at all, and no way to force a fresh engine if one
   wedges.
4. **Module-level mutable singletons** (`worker`, `ready`, `queue`). Simple and
   fine for a client-side spike; would need rethinking if this ever ran anywhere
   with concurrent sessions per process. It won't — engines are client-side by
   design — but it's worth being a conscious choice rather than an accident.
5. **`MOVE_TIME_MS = 500` sets the pace of the whole demo.** ~500 ms × ~80 plies
   is roughly 40 s per auto-played game, before Task 6 adds its own inter-move
   delay. Task 6 should treat the two together, and if games feel slow to watch,
   this constant is the first dial to turn — not the delay.
6. **Chrome only.** Not tried in Firefox or Safari. Single-threaded wasm is
   broadly supported so I'd expect it to be fine, but "expect" isn't "verified".
7. **The scratch page ships to production if this merges.** `/dev/stockfish-test`
   is unlinked from the menu and Task 8 deletes it, but it would be briefly live
   on the demo URL. Deleting it before merge is a legitimate call — it costs a
   verification surface that Task 3 and Task 6 would otherwise extend.

## Deployment Protection blocks preview verification

Vercel's Deployment Protection is on, so preview URLs `302` to SSO and no agent
can check a preview build — I hit this on PR #6 and fell back to a local
production build (`npm run build && npm run start`), which is the closest
equivalent I can reach without dashboard access.

`docs/deployment.md` §2 documents the fix (Settings → Deployment Protection).
Nobody has flipped it. Worth deciding deliberately: it's project-wide dashboard
config, it affects every agent's ability to verify their own work, and I left it
alone on purpose rather than change shared settings mid-flight.

## Scope: one addition, and what I stayed out of

**Added beyond my declared file list:** `scripts/cdp-verify.mjs`. The work order
didn't mention it because I didn't know `chromium-cli` would be missing. It's
committed rather than left in a temp folder so this PR's verification is
reproducible by you instead of being a claim in a doc. Flagging it because the
whole point of the work order was that my file list be predictable — say the
word and it comes back out.

**Untouched, as promised:** every hero file (`app/page.tsx`, `app/layout.tsx`,
`app/globals.css`, `components/*`), anything Vercel or KV (Task 9 is still
unclaimed and clean for whoever takes it), and `app/model-1v1` / `app/user-1v1`.
The check is:

```sh
git diff --name-only origin/main...feat/02-stockfish-spike
```

Use `origin/main`, **not** `main`. With a worktree in play the local `main` ref
belongs to whichever checkout has it and can lag behind — it was two commits
stale here, which made `README.md` look modified when it wasn't.

## Not in this PR

Task 3 (Maia ONNX spike) is next and separate — a 90-minute timeboxed
investigation with two legitimate outcomes, per `docs/phase-0-engine-spike.md`.
Task 7 (`Board`) is unclaimed and shares no files with this work.
