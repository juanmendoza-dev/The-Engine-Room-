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

## Corrections applied after review

Review rated this brief 9/10 and accepted it with three corrections, all upheld —
two claims whose evidence didn't support them, and one wrong causal explanation.
What changed:

1. **Dropped the "moves differ run to run proves `UCI_Elo` works" claim.** It
   doesn't: `go movetime` is nondeterministic from timing variance alone, so
   varying moves prove nothing either way. Replaced with the engine's advertised
   option list, which rules out the failure mode that actually matters. The
   reviewer's suggested substitute — depth per ELO — turned out **not** to
   discriminate on this build either; that's reported rather than worked around.
2. **Stopped citing wall-clock timing as proof of search.** A stub that slept for
   `movetime` would time identically. `getStockfishMove` now takes an optional
   `onInfo` callback, the scratch page reports the search depth reached, and the
   brief cites depth instead.
3. **Fixed Decision 2's justification.** The claim that `setoption` could be
   raced by a later `go` was wrong — a single-threaded UCI engine reads stdin in
   order. The handshake stays; the reasons are now the real ones.

Code changed as part of this: `web/lib/chess/engineStockfish.ts` gained the optional
`onInfo` parameter and `getAdvertisedOptions()`, and the scratch page was extended.
Neither touches `EngineConfig` / `EngineMove`, so the contract other tasks consume
is unchanged.

## Read these first, so you're not reviewing cold

- `docs/devlog/phase-0-engine-spike.md` — the work order I wrote **before** touching
  code: scope, which files I claimed, which I promised not to touch, and the
  engine contract. Merged as #5. Reviewing against this is the point: it's the
  thing I said I'd do, so any drift is visible.
- Task 2 in `docs/plans/2026-08-03-engine-room-implementation.md` —
  step-by-step, with a "What differed from the original plan" section.
- `docs/deployment.md` §4 — the binary-asset and Vercel traps this task had to
  respect. Two of them were live hazards here, not hypotheticals.

## What changed, file by file

| File | What it is | Why it looks like that |
| --- | --- | --- |
| `web/lib/chess/types.ts` | `EngineType`, `EngineConfig`, `EngineMove` | Verbatim from the spec's contract. Tasks 4/6/8/10 all import these, so it's the one file that shouldn't drift. |
| `web/lib/chess/engineStockfish.ts` | Worker + UCI wrapper, `getStockfishMove(fen, config, onInfo?)` plus `getAdvertisedOptions()` | The substance of the review. Diverges from the plan's draft in four places, each called out below. `onInfo` and `getAdvertisedOptions` exist only so verification can read search depth and the engine's advertised option list — neither is used by the game loop, and neither changes `EngineConfig`/`EngineMove`, so the published contract is untouched. |
| `web/public/stockfish/stockfish-18-lite-single.js` | 21 KB Emscripten loader | Copied unmodified from `node_modules/stockfish/bin/`. |
| `web/public/stockfish/stockfish-18-lite-single.wasm` | 7.0 MB engine | Same. Must sit beside the `.js` — Emscripten resolves it relative to the script. |
| `web/app/dev/stockfish-test/page.tsx` | Scratch verification page | Throwaway; Task 8 deletes it. Checks three things, not the plan's single position: that the engine advertises the options we set, that three positions yield legal moves with a reported search depth, and one position at two ELOs. |
| `.gitattributes` | `*.wasm` / `*.onnx` / `*.nnue` binary | Was missing. On Windows git will rewrite line endings inside a binary and corrupt it silently. |
| `web/scripts/cdp-verify.mjs` | Headless-Chrome driver | **Addition to my declared file list** — see "Scope" below. `.mjs` not `.js`: it uses top-level `await`, and in a package without `"type": "module"` the extension is what makes that unambiguous to both Node and ESLint. |
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

The plan waited only for `uciok` at startup. The handshake before each `go` stays,
but here are the honest reasons for it — an earlier version of this brief claimed
`setoption` could be "raced" by the `go` posted after it, **and that was wrong**.
A single-threaded UCI engine reads stdin strictly in order, so a command posted
later cannot overtake one posted earlier. Corrected because other agents will
treat this doc as reference.

The real reasons:

- **It's what UCI specifies.** `isready` → `readyok` is the protocol's defined way
  to confirm the engine has finished processing what you've sent and is ready for
  the next command. Using the specified mechanism beats relying on an ordering
  guarantee you've inferred.
- **It covers `ucinewgame`, which can be slow.** That command triggers an internal
  state reset — clearing hash tables and search history. The UCI spec explicitly
  says the engine may take a while and that the GUI should wait for `readyok`
  after it. That's the one command in our sequence with real work behind it.
- **It holds across builds we haven't tested.** The in-order guarantee is a
  property of this single-threaded build's stdin handling. `readyok` is a property
  of the protocol. If anyone later swaps in the multi-threaded build or a
  different engine, the handshake keeps working and the assumption might not.

Cost is one round-trip per move against a 500 ms search, so there's no real reason
to remove it even though the original justification didn't hold up.

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
machine, but Chrome is, and `web/scripts/cdp-verify.mjs` needs no dependencies at all
(Node 22+ has `fetch` and `WebSocket` built in):

```sh
"/c/Program Files/Google/Chrome/Application/chrome.exe" \
  --headless=new --remote-debugging-port=9222 \
  --user-data-dir=/tmp/cdp-profile about:blank &

node web/scripts/cdp-verify.mjs http://localhost:3000/dev/stockfish-test done 150000 9222
```

It prints the page text plus any `Runtime.exceptionThrown` / console errors, and
exits non-zero if the page never finished. What I got, production build:

```
== options: does this build actually advertise the knobs we set? ==
option name UCI_LimitStrength type check default false
option name UCI_Elo type spin default 1320 min 1320 max 3190

== legality: does every position yield a chess.js-legal move? ==
LEGAL    elo 1320  start position        e2e3 (e3)   depth 16  508ms
LEGAL    elo 1800  mid-opening           d2d4 (d4)   depth 13  506ms
LEGAL    elo 2800  king + pawn endgame   e3f3 (Kf3)  depth 45  506ms

== strength: same position, two ELOs, depth + move played ==
elo 1320  run 1  depth 13    played a3   507ms
elo 1320  run 2  depth 13    played a3   506ms
elo 2800  run 1  depth 13    played Nc3  508ms
elo 2800  run 2  depth 13    played d4   508ms
```

### What that output does and doesn't prove

Being precise here, because the first version of this brief overclaimed in two
places and a reference doc shouldn't.

**Proven — the options are real.** The two `option name` lines are the engine's
own handshake output. This matters because a UCI engine **silently ignores
`setoption` for a name it doesn't recognise** — no error, no warning. So a typo
or an unsupported option is indistinguishable from a working one at runtime, and
reading the advertised list is the only way to rule it out. `MISSING` on either
line would mean we've been setting nothing at all.

It also pins the real range: **`UCI_Elo` is 1320–3190 on this build.** That
validates the preset choices (1320 is exactly the floor, not an arbitrary pick)
and bounds soft spots 1 and 2 below with a real number instead of "roughly".

**Proven — a real search happens.** The `depth` values come from the engine's
`info depth ...` stream, and they track position complexity the way a genuine
alpha-beta search does: **45** in the sparse king-and-pawn endgame, **13** in the
crowded middlegame, 16 from the start position. A stub that slept and returned a
random legal move would report `depth NONE`.

Note that **wall-clock timing proves nothing here** — that was the first
version's mistake. A wrapper that slept for `movetime` and returned a random
legal move produces identical timings. The timings only show `movetime` was
honoured; depth is the evidence of search.

**Not proven — that ELO changes playing strength.** Depth is **identical at 1320
and 2800** (13 across all four runs). That's not a bug: Stockfish limits strength
by selecting a weaker move from the multi-PV candidates, not by searching less
deep, so depth cannot discriminate ELO on this build. Recording that explicitly
because "a strength-limited engine reads shallower" sounds obviously true and
isn't — for this engine.

The move choices are *suggestive* — 1320 played `a3` twice where 2800 played
`Nc3` and `d4` — but four moves is an anecdote, not a measurement of a rating
gap, and I'm not dressing it up as one.

Where this becomes genuinely measurable is **Task 6**: a 1320 side against a 2800
side over several complete auto-played games, scored by results. That's the right
place for it — it needs a game loop, which is Task 6's job, not this spike's.
What this spike is responsible for is that the options exist, are accepted, and
that the engine searches and returns legal moves. That much is established.

`ILLEGAL` in that output would mean chess.js rejected the engine's move —
whether the encoding is wrong or the engine is confused, chess.js is
authoritative per the spec, and that's a fail.

## What I'd challenge if I were reviewing this

Written by the author, so weight it accordingly — but these are the real soft
spots, not decorative ones:

1. **`config.elo ?? 1500` silently defaults.** A caller that forgets `elo` gets a
   1500-rated engine instead of an error. Defensible for a spike; arguably it
   should throw, since a silently-wrong difficulty is worse than a crash. The
   fallback is at least a legal value — 1500 sits inside the verified range.
2. **No `UCI_Elo` range validation.** The handshake output above pins the real
   range at **1320–3190** for this build. Outside it, Stockfish clamps quietly, so
   `elo: 400` would look like it worked. All three presets are in range, so nothing
   is broken today — but if Task 4 ever adds a preset from a remembered number
   rather than this measured range, that's where it would go wrong.
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
7. ~~**The scratch page ships to production if this merges.**~~ **Closed by
   review: keep it.** `/dev/stockfish-test` is unlinked from the menu, Task 8
   deletes it, and Task 3 extending it as a verification surface outweighs it
   being briefly live on the demo URL.

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

**Added beyond my declared file list:** `web/scripts/cdp-verify.mjs`. The work order
didn't mention it because I didn't know `chromium-cli` would be missing. It's
committed rather than left in a temp folder so this PR's verification is
reproducible by you instead of being a claim in a doc. Flagged because the whole
point of the work order was that my file list be predictable — **closed by review:
keep it**, a committed dependency-free repro being worth more than a pristine
file list.

**Untouched, as promised:** every hero file (`web/app/page.tsx`, `web/app/layout.tsx`,
`web/app/globals.css`, `web/components/*`), anything Vercel or KV (Task 9 is still
unclaimed and clean for whoever takes it), and `web/app/model-1v1` / `web/app/user-1v1`.
The check is:

```sh
git diff --name-only origin/main...feat/02-stockfish-spike
```

Use `origin/main`, **not** `main`. With a worktree in play the local `main` ref
belongs to whichever checkout has it and can lag behind — it was two commits
stale here, which made `README.md` look modified when it wasn't.

## Not in this PR

Task 3 (Maia ONNX spike) is next and separate — a 90-minute timeboxed
investigation with two legitimate outcomes, per `docs/devlog/phase-0-engine-spike.md`.
Task 7 (`Board`) is unclaimed and shares no files with this work.
