# The Engine Room Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a chess web app where you can watch two engines play each other (Model 1v1) or play an engine yourself (User 1v1), deployed on Vercel at zero cost.

**Architecture:** Next.js App Router app. Both engines (Stockfish via stockfish.wasm, Maia via ONNX) run entirely client-side behind one shared `getMoveFor(fen, config) => Promise<EngineMove>` contract, so the game loop and UI never know which engine they're talking to. The only server-side code is two Server Actions that read/write game records to KV.

**Tech Stack:** Next.js (TypeScript, App Router, Tailwind), chess.js, react-chessboard, stockfish (npm, single-threaded wasm build), onnxruntime-web, @vercel/kv.

## Global Constraints

- chess.js is the sole authority on legal moves and game-end detection. Engines only ever pick from `chess.moves()` — never hand-roll chess rules. (spec)
- No real training/fine-tuning of any model, now or later. If a future "learning" feature is requested, it's a heuristic layer over engine *settings* — flag and push back if a request drifts toward touching model weights. (spec)
- Out of scope for this submission: live LLM commentary, tournament mode, puzzle/training mode, opening repertoire tools. (spec)
- No user accounts/auth — fully anonymous, KV records aren't tied to identity. (spec)
- Zero budget: Vercel free tier + free-tier KV only. (spec)
- Stop after each phase (0, 1, 2, 3) and check in with the user before continuing — this plan is broken into phases for exactly that reason. (spec)
- No formal automated test suite for this MVP — every task's verification step is a concrete manual action (run the app, do X, observe Y), not an automated test. (spec, confirmed in design doc's Testing section)
- Commits: signed (already enforced by this repo's `.githooks/commit-msg` + `.claude/settings.json` — nothing extra needed in commands below), no AI co-author trailer (also hook-enforced), human-sounding messages, small and frequent. (AGENTS.md)

---

## Current priority — resequenced 2026-08-04

The original plan runs strictly Phase 0 → 1 → 2 → 3. **That order has been
changed once, deliberately**, in favour of getting a working Model 1v1 demo
sooner. What actually happened and why:

| Task | State |
| --- | --- |
| 1 — Scaffold | done, `#2` |
| 5 — Menu / hero | done, `#4` |
| 2 — Stockfish spike | done, `#6` |
| 7, 4, 6, 8 — Board, registry, game loop, Model 1v1 screen | done, `#8` — this was the demo |
| 3 — Maia ONNX spike | **done, open in `#7`** — reviewed in `#12`, verdict "merge"; the last task not on `main` |
| 9 — KV persistence | done, `#11` — adapter shape, KV itself still unprovisioned (see task notes) |
| 10 — User 1v1 | done, `#10`; `saveGame` stitched in `#13` |
| 11 — History page | done, `#11` (same PR as Task 9) |

**Every numbered task is now built.** Task 3 is the only one not merged to
`main` — it lives in PR `#7` awaiting the owner's merge call, with its review in
`#12`. Checkboxes below are unreliable (they were only ever maintained for
Task 1); this table is the truth.

**Maia did land, so Task 4's fallback never fired.** `MAIA_PRESETS` is populated
with the three verified tiers and `engines.ts` imports `engineMaia` for real —
earlier revisions of this section said the file didn't exist, which stopped being
true inside PR `#7`. Maia 2 takes the rating as a model *input*, so all three
presets are one weight file. Details in `docs/maia-notes.md`.

(Branch-local commit SHAs are deliberately not cited anywhere in this doc: a
rebase rewrites them, and the squash-merge rewrites them again, so they go stale
twice before anyone reads them. PR numbers survive both.)

**Task 9 (KV) is deferred, not dropped.** It needs Vercel dashboard provisioning;
`/history` runs on the localStorage adapter today and flips to KV via
`NEXT_PUBLIC_KV_ENABLED=1` after a redeploy. Runbook in `docs/deployment.md` §3.
The `saveGame` calls are live on both game screens, not commented.

**The phase check-in gate still stands** — the resequencing is about which task
comes next, not about skipping the stop-and-report points. Task 3 is the Phase 0
gate, and Phases 1–3 are all functionally live in production, so that check-in is
due as well.

Lane ownership, so parallel agents don't collide:
[`phase-0-engine-spike.md`](../devlog/phase-0-engine-spike.md) (Tasks 2, 3) and
[`model-1v1-work-order.md`](../devlog/model-1v1-work-order.md) (Tasks 7, 4, 6, 8).

---

## Phase 0 — Engine Integration Spike

No UI in this phase. The goal is to prove the two riskiest integrations work in isolation, so integration risk can't surface halfway through Phase 1 with no time left to recover.

### Task 1: Scaffold Next.js into the existing repo

The repo already has `.git`, `AGENTS.md`, `.githooks/`, `.claude/`, `docs/`, and `README.md`. `create-next-app` doesn't run cleanly into a non-empty directory, so scaffold in a sibling temp folder and merge in by hand, rather than running it in place.

**Files:**
- Create: everything a standard `create-next-app` TypeScript/App Router/Tailwind project generates (`package.json`, `tsconfig.json`, `next.config.ts`, `web/app/layout.tsx`, `web/app/page.tsx`, `web/app/globals.css`, `web/public/`, `.eslintrc`, `.gitignore`)
- Preserve: `README.md` (existing content, not the generated boilerplate)

**Done — commit `55755e0`.** Built with create-next-app **16.3.0** (Next 16.3.0,
React 19.2.8, Tailwind 4). The steps below are what actually ran; see "What
differed from the original plan" at the end of this task for why.

- [x] **Step 1: Scaffold into a sibling temp directory**

```bash
cd "C:\Users\juanm\Desktop"
npx create-next-app@latest ./engine-room-scaffold --yes \
  --typescript --tailwind --eslint --app --import-alias "@/*" \
  --use-npm --skip-install --disable-git --no-agents-md
```

`--disable-git` and `--skip-install` mean there's no nested `.git` or
`node_modules` to strip afterwards. `--yes` suppresses prompts. Omitting
`--src-dir` is what gets you no `src/` directory — it's opt-in.

- [x] **Step 2: Merge the scaffold into the repo root**

Delete the scaffold's own README first so it can't overwrite ours — cleaner than
backing ours up and restoring it:

```bash
rm engine-room-scaffold/README.md
cp -r engine-room-scaffold/. "The Engine Room/"
rm -rf engine-room-scaffold
```

Then confirm nothing of ours was clobbered: `README.md`, `AGENTS.md`,
`.githooks/`, `.claude/`, `docs/`.

- [x] **Step 3: Rename the package**

`package.json` inherits the temp folder's name. Set `"name": "the-engine-room"`.

- [x] **Step 4: Stop `next dev` from writing to AGENTS.md**

Next 16's dev server appends a `<!-- BEGIN:nextjs-agent-rules -->` block to
`AGENTS.md` on **every run** — the `--no-agents-md` scaffold flag does not
prevent this, it's a separate runtime feature. Deleting the block just recreates
it on the next `next dev`. With several agents on several branches, that's the
same phantom diff on all of them and a guaranteed conflict. So in
`next.config.ts`:

```ts
const nextConfig: NextConfig = {
  agentRules: false,
};
```

- [x] **Step 5: Install and verify**

```bash
npm install
npm run build     # what Vercel runs — catches TS/lint errors the dev server won't
npm run dev
```

`npm run build` succeeded (routes `/` and `/_not-found`, both static).
`http://localhost:3000` returned HTTP 200 serving the starter page. After
restarting `next dev` with `agentRules: false`, `git status` on `AGENTS.md` was
clean — fix verified, not just assumed.

One npm warning is expected and harmless: `unrs-resolver` has an unapproved
postinstall script (npm 11's allow-scripts gate). It's a transitive ESLint
dependency; the build and dev server don't need it.

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "scaffold the nextjs app into the repo"
```

#### What differed from the original plan

Worth knowing, since the same traps apply to later tasks:

- The original Step 1 `cd` path was `C:\Users\superCookie\Desktop\...` — a
  different machine. Real path is `C:\Users\juanm\Desktop\The Engine Room`.
- `--src-dir=false` isn't valid on create-next-app 16; `--src-dir` is opt-in, so
  you just omit it.
- `--agents-md` is **default on** in v16 and generates an `AGENTS.md`. Without
  `--no-agents-md` the copy step would have overwritten this repo's rules file.
  The runtime version of the same feature needs the `agentRules: false` config
  above — two separate switches for what looks like one feature.
- The generated `.gitignore` ignores `.env*` (broader than the `.env*.local` the
  plan's Task 9 assumes) and already includes `.vercel`. Nothing to add.

---

### Task 2: Stockfish.wasm spike

UCI is a stable, well-documented text protocol — this task can be written with full confidence, unlike Task 3.

**Files:**
- Create: `web/lib/chess/types.ts`
- Create: `web/lib/chess/engineStockfish.ts`
- Create: `web/public/stockfish/` (copied single-threaded build files)
- Create: `web/app/dev/stockfish-test/page.tsx` (scratch verification page, removed in Task 8)
- Modify: `package.json` (add `chess.js`, `stockfish`)

**Interfaces:**
- Produces: `EngineConfig`, `EngineMove` types (used by every later chess task). `getStockfishMove(fen: string, config: EngineConfig) => Promise<EngineMove>`.

**Done — commit `54f050d`.** Built against `stockfish@18.0.8`, using the **lite
single-threaded** build. The steps below are what actually ran; see "What
differed from the original plan" at the end of this task for why the build
choice changed.

- [x] **Step 1: Install dependencies**

```bash
npm install chess.js stockfish
```

- [x] **Step 2: Find and copy the single-threaded build**

The files live in `node_modules/stockfish/bin/`, not `src/`. v18 ships five
flavours; the sizes are the whole story:

| File | Size | Verdict |
| --- | --- | --- |
| `stockfish-18.wasm` (multi-threaded) | 107.8 MB | needs COOP/COEP, and too big |
| `stockfish-18-single.wasm` | 107.8 MB | **GitHub hard-rejects >100 MB** |
| `stockfish-18-lite.wasm` (multi) | 6.8 MB | needs COOP/COEP |
| `stockfish-18-lite-single.wasm` | 7.0 MB | ✅ what we use |
| `stockfish-18-asm.js` | 10.0 MB | JS fallback, very slow |

```bash
mkdir -p web/public/stockfish
cp node_modules/stockfish/bin/stockfish-18-lite-single.js web/public/stockfish/
cp node_modules/stockfish/bin/stockfish-18-lite-single.wasm web/public/stockfish/
```

Both files must sit in the same directory — Emscripten resolves the `.wasm`
relative to the `.js`. No separate `.nnue` file is needed; the net is embedded.

Add the binary rules to `.gitattributes` **before** `git add`-ing the wasm, per
`docs/deployment.md` §4 — on Windows git will otherwise rewrite line endings
inside the binary and silently corrupt it:

```
*.wasm binary
*.onnx binary
*.nnue binary
```

- [x] **Step 3: Write the shared types**

```typescript
// web/lib/chess/types.ts
export type EngineType = "stockfish" | "maia" | "human";

export interface EngineConfig {
  type: EngineType;
  label: string;
  elo?: number; // stockfish only (UCI_Elo)
  ratingTier?: number; // maia only (1100-1900)
}

export interface EngineMove {
  from: string;
  to: string;
  promotion?: string;
}
```

- [x] **Step 4: Write the Stockfish wrapper**

> **Read `web/lib/chess/engineStockfish.ts`, not the snippet below.** The snippet
> was the plan's first draft and four things in it needed changing — the worker
> path, the handshake, request serialization, and error/timeout handling. All
> four are listed under "What differed" at the end of this task.

```typescript
// web/lib/chess/engineStockfish.ts
import type { EngineConfig, EngineMove } from "./types";

let worker: Worker | null = null;
let ready: Promise<void> | null = null;

function getWorker(): Worker {
  if (!worker) {
    // update this path to match whatever filename Task 2 Step 2 found
    worker = new Worker("/stockfish/stockfish-single.js");
  }
  return worker;
}

function initEngine(): Promise<void> {
  if (ready) return ready;
  const w = getWorker();
  ready = new Promise((resolve) => {
    function onMessage(e: MessageEvent) {
      if (e.data === "uciok") {
        w.removeEventListener("message", onMessage);
        resolve();
      }
    }
    w.addEventListener("message", onMessage);
    w.postMessage("uci");
  });
  return ready;
}

function parseUciMove(uci: string): EngineMove {
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci.slice(4, 5) : undefined,
  };
}

export async function getStockfishMove(fen: string, config: EngineConfig): Promise<EngineMove> {
  const w = getWorker();
  await initEngine();

  return new Promise((resolve) => {
    function onMessage(e: MessageEvent) {
      const line = e.data;
      if (typeof line === "string" && line.startsWith("bestmove")) {
        w.removeEventListener("message", onMessage);
        resolve(parseUciMove(line.split(" ")[1]));
      }
    }
    w.addEventListener("message", onMessage);

    w.postMessage("ucinewgame");
    w.postMessage("setoption name UCI_LimitStrength value true");
    w.postMessage(`setoption name UCI_Elo value ${config.elo}`);
    w.postMessage(`position fen ${fen}`);
    w.postMessage("go movetime 500");
  });
}
```

- [x] **Step 5: Write a scratch verification page**

The shipped page does three things rather than the one position the snippet
below checks:

1. Prints the `option name UCI_LimitStrength` / `option name UCI_Elo` lines from
   the UCI handshake. A UCI engine **silently ignores `setoption` for a name it
   doesn't know**, so this is the only way to tell a working option from a typo.
2. Runs three positions at three ELOs — one position can pass by luck.
3. Reports the **search depth** reached per move, from the engine's `info depth`
   stream. Depth is the evidence that a real search happened; wall-clock time
   isn't, because a stub that slept for `movetime` and returned a random legal
   move would time identically.

```tsx
// web/app/dev/stockfish-test/page.tsx
"use client";
import { useEffect, useState } from "react";
import { Chess } from "chess.js";
import { getStockfishMove } from "@/lib/chess/engineStockfish";

export default function StockfishTestPage() {
  const [result, setResult] = useState("running...");

  useEffect(() => {
    const chess = new Chess();
    getStockfishMove(chess.fen(), { type: "stockfish", label: "test", elo: 1800 }).then((move) => {
      const applied = chess.move({ from: move.from, to: move.to, promotion: move.promotion });
      setResult(applied ? `legal move: ${JSON.stringify(move)}` : `ILLEGAL move returned: ${JSON.stringify(move)}`);
    });
  }, []);

  return <pre>{result}</pre>;
}
```

- [x] **Step 6: Manual verification**

`npm run build` first — it's what Vercel runs and it catches TS/lint the dev
server won't. Clean, with `/dev/stockfish-test` prerendering as static.

Then `npm run start` (production build — closer to Vercel than `npm run dev`) and
visit `http://localhost:3000/dev/stockfish-test`. Result:

```
option name UCI_LimitStrength type check default false
option name UCI_Elo type spin default 1320 min 1320 max 3190

LEGAL    elo 1320  start position        e2e3 (e3)   depth 16  508ms
LEGAL    elo 1800  mid-opening           d2d4 (d4)   depth 13  506ms
LEGAL    elo 2800  king + pawn endgame   e3f3 (Kf3)  depth 45  506ms

elo 1320  run 1  depth 13    played a3   507ms
elo 1320  run 2  depth 13    played a3   506ms
elo 2800  run 1  depth 13    played Nc3  508ms
elo 2800  run 2  depth 13    played d4   508ms
```

No console errors. Two things later tasks should take from this:

- **`UCI_Elo`'s real range on this build is 1320–3190.** 1320 is the floor, which
  is why it's the lowest preset. Task 4 shouldn't invent presets outside that —
  Stockfish clamps silently, so a bad value looks like it worked.
- **Depth does not vary with ELO** (13 at both 1320 and 2800). Stockfish limits
  strength by choosing a weaker move from the multi-PV candidates, not by
  searching shallower. So this spike proves the options are accepted and the
  engine searches; it does **not** prove the ELO settings change playing
  strength. That only becomes measurable in Task 6, over several complete games
  between a low and a high preset, scored by results.

Verified in headless Chrome over the DevTools Protocol rather than by eye —
`chromium-cli` and Playwright aren't installed on this machine, but Chrome is,
so a throwaway CDP script (`--headless=new --remote-debugging-port`) navigated
the page, polled `document.body.innerText` until it printed `done`, and dumped
`Runtime.exceptionThrown` / console errors. Worth reusing for later tasks;
it needs no dependencies, since Node 22+ has `fetch` and `WebSocket` built in.

If the worker fails to load, check the path in `ENGINE_URL` against what's
actually in `web/public/stockfish/`.

- [x] **Step 7: Commit**

```bash
git add .gitattributes web/lib/chess/types.ts web/lib/chess/engineStockfish.ts web/public/stockfish web/app/dev/stockfish-test package.json package-lock.json
git commit -m "get stockfish talking over uci in a web worker"
```

#### What differed from the original plan

- **The build.** The plan said "single-threaded"; the correct choice is
  **lite** single-threaded. Plain `stockfish-18-single.wasm` is 107.8 MB and
  GitHub hard-rejects files over 100 MB, so it cannot be committed here at all —
  and Git LFS is not a way out, because Vercel doesn't fetch LFS objects during
  a build (the asset would arrive as pointer text and break at runtime while
  working fine locally). The lite net is weaker but we cap at `UCI_Elo` 2800
  anyway, and the package's own README recommends lite-single as the default.
- **Where the files live.** `node_modules/stockfish/bin/`, not `src/`.
- **`stockfish@18.0.8` has a postinstall script that npm 11 blocks** (the
  allow-scripts gate, same warning as Task 1's `unrs-resolver`). It's harmless
  to leave blocked: all it does is create a `bin/stockfish.js` symlink to the
  full build. Copy the versioned filenames directly and you never need it —
  which also avoids committing a symlink, which would be its own mess on
  Windows.
- **No `{ type: "module" }`.** The build is a classic worker script — it uses
  `importScripts` and has no `export`, so plain `new Worker(url)` is right.
- **No separate `.nnue` file** and no `SharedArrayBuffer`/`Atomics` anywhere in
  the build, which reconfirms the spec's "no COOP/COEP headers" call.
- **`isready`/`readyok` before `go`.** The plan only waited for `uciok` at
  startup. Note the reason carefully, because the obvious one is wrong: a
  single-threaded UCI engine reads stdin **in order**, so a later `go` cannot
  overtake an earlier `setoption`. The handshake is worth having because it's the
  protocol's specified way to confirm processing is complete, because
  `ucinewgame` triggers a state reset the spec says may be slow and should be
  waited on, and because it stays correct on engine builds we haven't tested.
  Costs one round-trip against a 500 ms search.
- **Calls are serialized through a promise queue.** There's one shared worker
  and replies are matched by listening for the next matching line, so two
  overlapping `go` commands would resolve each other's promises and hand back
  the wrong move. The game loop awaits each move so it wouldn't trigger today,
  but it's four lines to make the module safe for any caller.
- **Timeouts and `error` handling.** A worker that fails to load, or an engine
  that goes silent, now rejects with a real message instead of leaving the
  promise pending forever. That's what makes the spec's "Engine failed to load,
  refresh" inline error possible.
- **`.gitattributes`** needed the binary rules added; it only had `eol=lf` rules
  for the hook directories.

---

### Task 3: Maia ONNX spike (investigation, timeboxed)

This is fundamentally different from Task 2. Stockfish speaks a stable text protocol; Maia-via-ONNX is a raw lc0-derived neural network. Before any move comes out, the board has to be encoded into lc0's input planes and the policy output decoded back into a move — neither of which is a solved problem going into this task. Do not fabricate that encode/decode logic with unverified guesses; work it out for real, checkpoint by checkpoint, and stop at the timebox if it's not converging.

**Timebox: 90 minutes.** If checkpoint 7 isn't reached by then, stop and take the fallback below. That is not a failure state — it's the plan working as designed.

**Files:**
- Create: `web/lib/chess/engineMaia.ts`
- Create: `docs/maia-notes.md` (what you found/did at each checkpoint, however far you got)
- Create: `web/public/maia/1500.onnx` (if you get far enough to have one)

**Interfaces:**
- Produces (if successful): `getMaiaMove(fen: string, config: EngineConfig) => Promise<EngineMove>` — same signature as `getStockfishMove`.
- Produces (if fallback taken): `getMaiaMove` still exists and has that signature, but its body throws `new Error("Maia not available")`.

**Done — PR `#7`. Maia works.** But the checkpoints below did *not* run as
written, so read **`docs/maia-notes.md`** rather than following them — it's the
authoritative record. In short:

- CP1 (check for something turnkey first) paid off in ~5 minutes and made CP2–CP6
  unnecessary. The plan aimed at **original Maia** (lc0 `.pb.gz`, `leela2onnx`, 112
  planes with move history, one network per tier). We use **Maia 2**, which is
  already ONNX: no lc0, no conversion, no history planes, and the rating is a model
  *input* so one file covers every tier.
- Maia 3 exists and is newer, but its weights are **AGPL-3.0**, whose network
  clause reaches a deployed site. Maia 2 is **MIT** and encodes *more* (18 planes
  including castling and en passant; Maia 3 encodes piece placement only).
- The weights (93 MB) and move table are **fetched at runtime** from GitHub raw,
  not committed here. They're mirrored in our own
  `juanmendoza-dev/engine-room-assets` rather than hotlinked from CSSLab, who have
  since deleted the file from their `main`. Only MIT-licensed `onnxruntime-web`
  assets are vendored, and only the two ORT files actually loaded.
- ONNX interface: `boards` float32 `[1,18,8,8]`, `elo_self` / `elo_oppo` as
  **int64 bucket indices**; outputs `logits_maia`, `logits_side_info` (unused),
  `logits_value`. Read off the session, not assumed.
- ~35 ms per move, versus Stockfish's ~500 ms. Task 6 should treat inter-move delay
  as per-engine, not global.
- The odd openings (`Nf3` from the start, `Nf6` in reply to 1.e4) were flagged as
  an open question and are now **closed**: it's the released model's own behaviour,
  not our encoder. The review in `#12` reproduced the browser pipeline's output
  against CSSLab's *training-side* preprocessing in Python and got identical
  numbers to a tenth of a percentage point.
- **Post-review follow-ups, all done in this PR:** the ~25 s cold-load now streams
  a byte/percent readout on both game screens with a heads-up line and a stall
  timeout (it was a frozen board under a "thinking" lamp before); `web/public/ort/`
  dropped 13.6 MB of variants that are never fetched; the model moved to our own
  mirror. `docs/deployment.md` §4's stale COOP/COEP reasoning was corrected at the
  same time. What's still open is the IndexedDB model cache — Chrome won't
  disk-cache a body this size, so every full page load re-downloads it.

- [ ] **Checkpoint 1: Check for a turnkey browser-runnable Maia package first**

Search npm and GitHub for something that already does this before building a conversion pipeline by hand — try "maia chess onnx", "lc0 onnx web", "maia2". If something exists and can take a FEN and return a move in the browser, use it and skip to Checkpoint 5.

- [ ] **Checkpoint 2: Source Maia weights**

Maia's original weights are published in the CSSLab `maia-chess` GitHub repo as `.pb.gz` files, one per rating tier (1100–1900). Download the 1500 tier file.

- [ ] **Checkpoint 3: Convert to ONNX**

These are Leela Chess Zero (lc0) format weights. lc0 has an ONNX export path for its own onnx backend. Build or download lc0, then run its help output to find the actual current export command — don't trust a remembered flag name, the CLI has changed across versions:

```bash
lc0 --help
lc0 leela2onnx --help
```

Run whichever export command exists against the downloaded weights file. Output: `1500.onnx`.

- [ ] **Checkpoint 4: Inspect the ONNX graph's input/output shapes**

Use Netron (netron.app, drag in the `.onnx` file) or `onnxruntime-web`'s session metadata in a scratch script to find the exact input tensor shape (lc0 networks take a stack of 8x8 binary planes — piece positions, repetition count, move history — but the exact plane count and ordering depends on the network format version, so read it off the actual graph) and output shape (policy head = move probabilities indexed by lc0's move encoding; value head = position evaluation, not needed here).

- [ ] **Checkpoint 5: Write the FEN → input-planes encoder**

Match whatever shape Checkpoint 4 (or the turnkey package from Checkpoint 1) showed.

- [ ] **Checkpoint 6: Write the policy-output → move decoder**

Decode using lc0's move index scheme, then filter to only moves `chess.js` considers legal for the current position (`chess.moves({ verbose: true })`), and pick the legal move with the highest policy score. This is the correct way to use Maia — it's a policy network trained to predict human moves at a given rating, not a search engine, so no search/minimax is needed on top of it.

- [ ] **Checkpoint 7: Verify against known positions**

```typescript
// throwaway verification, not a permanent file
import { Chess } from "chess.js";
import { getMaiaMove } from "@/lib/chess/engineMaia";

const testFens = [
  new Chess().fen(), // starting position
  "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3", // mid-opening
  "8/8/8/4k3/8/4K3/4P3/8 w - - 0 1", // king+pawn endgame
];

for (const fen of testFens) {
  const chess = new Chess(fen);
  const move = await getMaiaMove(fen, { type: "maia", label: "test", ratingTier: 1500 });
  const applied = chess.move({ from: move.from, to: move.to, promotion: move.promotion });
  console.log(fen, "->", applied ? "LEGAL" : "ILLEGAL", move);
}
```

Confirm all three print `LEGAL`.

- [ ] **Step: Write the notes file**

```markdown
<!-- docs/maia-notes.md -->
# Maia ONNX conversion notes

Reached checkpoint: <N>
What worked:
What didn't / where it stalled:
Commands that worked (for next time):
```

Fill in real content based on what actually happened.

- [ ] **Step: Commit whatever state you're in**

```bash
git add web/lib/chess/engineMaia.ts docs/maia-notes.md web/public/maia
git commit -m "maia onnx spike, got to checkpoint N - notes in scripts"
```

**Fallback (decide now, not under pressure tomorrow):** If Checkpoint 7 isn't reached within the 90-minute timebox, Phase 1 ships with Stockfish-only presets — `MAIA_PRESETS` (Task 4) becomes an empty array, and the Maia dropdown options simply don't appear. Maia moves to the stretch-goal list alongside expanding to all 9 rating tiers. No other code changes are needed elsewhere — this is exactly why every later task talks to `getMoveFor`, never to Maia internals directly.

---

## Phase 1 — Model 1v1

### Task 4: Engine preset registry

**Done — `web/lib/chess/engines.ts`.** One deviation: `MAIA_PRESETS` is `[]` and
`engineMaia` is deliberately **not** imported. A static import of a module that
does not exist fails the build, so the snippet below cannot compile until Task 3
lands. Adding Maia later is three lines, all inside this one file — the insertion
point is commented at the site.

**Files:**
- Create: `web/lib/chess/engines.ts`

**Interfaces:**
- Consumes: `EngineConfig`, `EngineMove` (Task 2), `getStockfishMove` (Task 2), `getMaiaMove` (Task 3)
- Produces: `STOCKFISH_PRESETS`, `MAIA_PRESETS`, `ALL_ENGINE_PRESETS: EngineConfig[]`; `getMoveFor(fen: string, config: EngineConfig) => Promise<EngineMove>`

- [x] **Step 1: Write the registry**

```typescript
// web/lib/chess/engines.ts
import type { EngineConfig, EngineMove } from "./types";
import { getStockfishMove } from "./engineStockfish";
import { getMaiaMove } from "./engineMaia";

export const STOCKFISH_PRESETS: EngineConfig[] = [
  { type: "stockfish", label: "Stockfish 1320", elo: 1320 },
  { type: "stockfish", label: "Stockfish 1800", elo: 1800 },
  { type: "stockfish", label: "Stockfish 2800", elo: 2800 },
];

// If Task 3 ended in the fallback (Maia not working), set this to an empty
// array. Nothing else in this file or anywhere downstream needs to change.
export const MAIA_PRESETS: EngineConfig[] = [
  { type: "maia", label: "Maia 1100", ratingTier: 1100 },
  { type: "maia", label: "Maia 1500", ratingTier: 1500 },
  { type: "maia", label: "Maia 1900", ratingTier: 1900 },
];

export const ALL_ENGINE_PRESETS: EngineConfig[] = [...STOCKFISH_PRESETS, ...MAIA_PRESETS];

export async function getMoveFor(fen: string, config: EngineConfig): Promise<EngineMove> {
  if (config.type === "stockfish") return getStockfishMove(fen, config);
  if (config.type === "maia") return getMaiaMove(fen, config);
  throw new Error(`getMoveFor called with a non-engine config: ${config.type}`);
}
```

- [x] **Step 2: Manual verification**

In a scratch browser console on any page (or extend the Task 2 test page temporarily), import and call `getMoveFor(new Chess().fen(), STOCKFISH_PRESETS[0])`, confirm it resolves to a move. If `MAIA_PRESETS` is non-empty, do the same with `MAIA_PRESETS[0]`.

- [x] **Step 3: Commit**

```bash
git add web/lib/chess/engines.ts
git commit -m "add the engine preset list and a single getMoveFor entry point"
```

---

### Task 5: Menu screen

**Design reference:** `docs/design/hero-preview.html` (open directly in a
browser) + `docs/design/hero-notes.md` for the token table, copy, and a
translation note — the preview uses a design tool's own template syntax,
not JSX, so it's a visual/interaction spec to build from, not code to copy.

**Files:**
- Modify: `web/app/page.tsx`

- [ ] **Step 1: Replace the default page with the menu**

```tsx
// web/app/page.tsx
import Link from "next/link";

export default function MenuPage() {
  return (
    <main style={{ display: "flex", flexDirection: "column", gap: "1rem", padding: "2rem" }}>
      <h1>The Engine Room</h1>
      <Link href="/model-1v1">Model 1v1 — watch two engines play</Link>
      <Link href="/user-1v1">User 1v1 — play an engine yourself</Link>
      <Link href="/history">Game history</Link>
    </main>
  );
}
```

- [ ] **Step 2: Manual verification**

`npm run dev`, visit `/`, confirm the three links render (the latter two will 404 until later tasks — that's expected right now).

- [ ] **Step 3: Commit**

```bash
git add web/app/page.tsx
git commit -m "add the menu screen"
```

---

### Task 6: Game loop

**Done — `web/lib/chess/gameLoop.ts`.** Three corrections to the snippet below:

1. **chess.js 1.x `move()` throws** on an illegal move instead of returning
   `null`, so `if (!applied)` is dead code — a bad engine move would have killed
   the loop rather than falling back. Now a `try`/`catch`, which is what the
   spec's error-handling section actually asks for.
2. **Added an `AbortSignal`.** Without one, leaving the page mid-game left the
   loop running and the single shared engine worker busy.
3. **Inter-move delay 350ms, not 600ms** — Task 2 already spends
   `MOVE_TIME_MS` (500ms) per move thinking, and its notes flag that this loop
   should account for it.

**Files:**
- Create: `web/lib/chess/gameLoop.ts`

**Interfaces:**
- Consumes: `EngineConfig` (Task 2), `getMoveFor` (Task 4)
- Produces: `GameEndInfo`, `runModelGame(white, black, onMove, moveDelayMs?) => Promise<{moves: string[]} & GameEndInfo>`

- [x] **Step 1: Write the loop**

```typescript
// web/lib/chess/gameLoop.ts
import { Chess } from "chess.js";
import type { EngineConfig } from "./types";
import { getMoveFor } from "./engines";

export interface GameEndInfo {
  result: "1-0" | "0-1" | "1/2-1/2";
  endReason: "checkmate" | "stalemate" | "draw-repetition" | "draw-50move" | "draw-insufficient";
}

function describeEnd(chess: Chess): GameEndInfo {
  if (chess.isCheckmate()) {
    return { result: chess.turn() === "w" ? "0-1" : "1-0", endReason: "checkmate" };
  }
  if (chess.isStalemate()) return { result: "1/2-1/2", endReason: "stalemate" };
  if (chess.isThreefoldRepetition()) return { result: "1/2-1/2", endReason: "draw-repetition" };
  if (chess.isInsufficientMaterial()) return { result: "1/2-1/2", endReason: "draw-insufficient" };
  return { result: "1/2-1/2", endReason: "draw-50move" };
}

export async function runModelGame(
  white: EngineConfig,
  black: EngineConfig,
  onMove: (fen: string, sanMove: string) => void,
  moveDelayMs = 600
): Promise<{ moves: string[] } & GameEndInfo> {
  const chess = new Chess();
  const moves: string[] = [];

  while (!chess.isGameOver()) {
    const active = chess.turn() === "w" ? white : black;
    const move = await getMoveFor(chess.fen(), active);
    const applied = chess.move({ from: move.from, to: move.to, promotion: move.promotion });

    if (!applied) {
      // Defensive fallback: an engine returned something outside chess.moves().
      // chess.js stays authoritative — pick a random legal move instead of breaking the game.
      const legal = chess.moves({ verbose: true });
      const fallback = legal[Math.floor(Math.random() * legal.length)];
      chess.move({ from: fallback.from, to: fallback.to, promotion: fallback.promotion });
      moves.push(fallback.san);
      onMove(chess.fen(), fallback.san);
    } else {
      moves.push(applied.san);
      onMove(chess.fen(), applied.san);
    }

    await new Promise((resolve) => setTimeout(resolve, moveDelayMs));
  }

  return { moves, ...describeEnd(chess) };
}
```

- [x] **Step 2: Manual verification**

Temporarily call `runModelGame(STOCKFISH_PRESETS[0], STOCKFISH_PRESETS[1], (fen) => console.log(fen))` from the Task 2 scratch page (or a new throwaway one) and confirm it logs a sequence of FENs and eventually resolves with a `result`/`endReason`/`moves` array.

- [x] **Step 3: Commit**

```bash
git add web/lib/chess/gameLoop.ts
git commit -m "wire up the model-vs-model game loop"
```

---

### Task 7: Board component

**Done — `web/components/Board.tsx`.** `react-chessboard` v5 moved every prop into a
single `options` object and renamed `arePiecesDraggable` → `allowDragging`, so the
v4-shaped snippet below does not compile. The plan did warn to check this. Squares
use the hero's `--er-sq-*` tokens so the board matches the rest of the app.

One component, reused read-only in Model 1v1 (Task 8) and interactively in User 1v1 (Task 10).

**Files:**
- Create: `web/components/Board.tsx`
- Modify: `package.json` (add `react-chessboard`)

**Interfaces:**
- Produces: `<Board fen interactive? onPieceDrop? orientation? />`

- [x] **Step 1: Install**

```bash
npm install react-chessboard
```

- [x] **Step 2: Write the component**

```tsx
// web/components/Board.tsx
"use client";
import { Chessboard } from "react-chessboard";

interface BoardProps {
  fen: string;
  interactive?: boolean;
  onPieceDrop?: (from: string, to: string) => boolean;
  orientation?: "white" | "black";
}

export function Board({ fen, interactive = false, onPieceDrop, orientation = "white" }: BoardProps) {
  return (
    <Chessboard
      position={fen}
      boardOrientation={orientation}
      arePiecesDraggable={interactive}
      onPieceDrop={(from, to) => (onPieceDrop ? onPieceDrop(from, to) : false)}
    />
  );
}
```

If the installed `react-chessboard` version's prop names don't match (`position`/`boardOrientation`/`arePiecesDraggable`/`onPieceDrop`), check its type definitions (`node_modules/react-chessboard/dist/**/*.d.ts`) or README for the current API and adjust — the library has changed its prop surface across major versions.

- [x] **Step 3: Manual verification**

Drop `<Board fen={new Chess().fen()} />` onto any page temporarily, confirm the starting position renders.

- [x] **Step 4: Commit**

```bash
git add web/components/Board.tsx package.json package-lock.json
git commit -m "add a shared board component for both game modes"
```

---

### Task 8: Model 1v1 page

**Done — `web/app/model-1v1/page.tsx`, plus `EngineConfigPicker` and `ResultScreen`.**
Styled with the hero's design tokens instead of the inline styles below. Two
additions beyond the snippet, both of which a spectate screen needs to be legible
at all: a numbered move log, and a "thinking" indicator naming the side and
engine. `saveGame` stays commented for Task 9.

**`web/app/dev/stockfish-test/` was NOT deleted.** The plan has this task remove it,
but it is the manual verification entry point for the engine this screen depends
on and Task 3 is still in flight. Deleting it is a one-line follow-up whenever
Phase 0 closes.

**Files:**
- Create: `web/components/EngineConfigPicker.tsx`
- Create: `web/components/ResultScreen.tsx`
- Create: `web/app/model-1v1/page.tsx`
- Delete: `web/app/dev/stockfish-test/` (superseded by this page)

**Interfaces:**
- Consumes: `ALL_ENGINE_PRESETS`, `getMoveFor` indirectly via `runModelGame` (Task 4, Task 6), `Board` (Task 7), `saveGame` (Task 9 — see note below)
- Produces: `<EngineConfigPicker presets value onChange label />`, `<ResultScreen result endReason whiteLabel blackLabel onRematch? />`

Note: this task references `saveGame` from Task 9, which comes after it. Write this task's page first with the `saveGame` call included but commented out, then uncomment it as the last step of Task 9. Keeps each task's commit buildable on its own.

- [x] **Step 1: Engine config picker**

```tsx
// web/components/EngineConfigPicker.tsx
"use client";
import type { EngineConfig } from "@/lib/chess/types";

interface Props {
  presets: EngineConfig[];
  value: EngineConfig | null;
  onChange: (config: EngineConfig) => void;
  label: string;
}

export function EngineConfigPicker({ presets, value, onChange, label }: Props) {
  return (
    <label>
      {label}
      <select
        value={value?.label ?? ""}
        onChange={(e) => {
          const found = presets.find((p) => p.label === e.target.value);
          if (found) onChange(found);
        }}
      >
        <option value="" disabled>
          Choose an engine
        </option>
        {presets.map((p) => (
          <option key={p.label} value={p.label}>
            {p.label}
          </option>
        ))}
      </select>
    </label>
  );
}
```

- [x] **Step 2: Result screen**

```tsx
// web/components/ResultScreen.tsx
interface Props {
  result: "1-0" | "0-1" | "1/2-1/2";
  endReason: string;
  whiteLabel: string;
  blackLabel: string;
  onRematch?: () => void;
}

export function ResultScreen({ result, endReason, whiteLabel, blackLabel, onRematch }: Props) {
  const summary =
    result === "1/2-1/2" ? "Draw" : result === "1-0" ? `${whiteLabel} wins` : `${blackLabel} wins`;

  return (
    <div>
      <h2>{summary}</h2>
      <p>{endReason}</p>
      {onRematch && <button onClick={onRematch}>Play again</button>}
    </div>
  );
}
```

- [x] **Step 3: Model 1v1 page**

```tsx
// web/app/model-1v1/page.tsx
"use client";
import { useState } from "react";
import { Chess } from "chess.js";
import { Board } from "@/components/Board";
import { EngineConfigPicker } from "@/components/EngineConfigPicker";
import { ResultScreen } from "@/components/ResultScreen";
import { ALL_ENGINE_PRESETS } from "@/lib/chess/engines";
import { runModelGame, type GameEndInfo } from "@/lib/chess/gameLoop";
import type { EngineConfig } from "@/lib/chess/types";
// import { saveGame } from "@/app/actions/games"; // uncomment in Task 9

export default function Model1v1Page() {
  const [white, setWhite] = useState<EngineConfig | null>(null);
  const [black, setBlack] = useState<EngineConfig | null>(null);
  const [fen, setFen] = useState(new Chess().fen());
  const [playing, setPlaying] = useState(false);
  const [end, setEnd] = useState<(GameEndInfo & { moves: string[] }) | null>(null);

  async function start() {
    if (!white || !black) return;
    setPlaying(true);
    setEnd(null);
    setFen(new Chess().fen());

    const outcome = await runModelGame(white, black, (nextFen) => setFen(nextFen));
    setEnd(outcome);
    setPlaying(false);

    // await saveGame({
    //   mode: "model-1v1",
    //   white: { type: white.type, label: white.label },
    //   black: { type: black.type, label: black.label },
    //   moves: outcome.moves,
    //   result: outcome.result,
    //   endReason: outcome.endReason,
    // }); // uncomment in Task 9
  }

  return (
    <main style={{ display: "flex", flexDirection: "column", gap: "1rem", padding: "2rem" }}>
      <h1>Model 1v1</h1>
      <EngineConfigPicker presets={ALL_ENGINE_PRESETS} value={white} onChange={setWhite} label="White" />
      <EngineConfigPicker presets={ALL_ENGINE_PRESETS} value={black} onChange={setBlack} label="Black" />
      <button onClick={start} disabled={playing || !white || !black}>
        {playing ? "Playing..." : "Start game"}
      </button>
      <Board fen={fen} />
      {end && (
        <ResultScreen
          result={end.result}
          endReason={end.endReason}
          whiteLabel={white?.label ?? "White"}
          blackLabel={black?.label ?? "Black"}
          onRematch={start}
        />
      )}
    </main>
  );
}
```

- [x] **Step 4: Remove the superseded scratch page**

```bash
rm -rf web/app/dev
```

- [x] **Step 5: Manual verification**

`npm run dev`, visit `/model-1v1`, pick two Stockfish presets, click Start, confirm the board updates move by move (not an instant jump) and a result screen appears when the game ends.

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "build the model 1v1 screen"
```

---

### Task 9: KV storage + saveGame

**Done — `#11`, with a deliberate structural deviation.** No KV store was ever
provisioned (Step 1 is dashboard work under the owner's login, owner away), so
storage shipped behind an adapter facade instead of KV-only: localStorage works
today, the KV adapter is written and dormant until `NEXT_PUBLIC_KV_ENABLED=1`.
See "What differed from the original plan" below — the KV half is
**untested against a real store** and the plan's Step 1 remains the owner's.

**Files (as actually built):**
- Create: `web/lib/games/types.ts` (`GameRecord` and friends — client-safe)
- Create: `web/lib/games/localStore.ts` (localStorage adapter, 50-record cap)
- Create: `web/lib/games/store.ts` (`saveGame`/`listGames` facade both screens call)
- Create: `web/app/actions/games.ts` (`"use server"`, the KV adapter)
- Modify: `web/app/model-1v1/page.tsx` (wire the `saveGame` call from Task 8)
- Modify: `package.json` (add `@vercel/kv`)

**Interfaces:**
- Produces: `GameRecord` type, `saveGame(game: Omit<GameRecord, "id" | "timestamp">) => Promise<void>`

- [ ] **Step 1: Provision KV storage** *(still open — owner-only dashboard work; the runbook, including the `NEXT_PUBLIC_KV_ENABLED=1` flip, is docs/deployment.md §3)*

In the Vercel dashboard, create a KV storage integration for this project and link it (this may now be under "Marketplace Database Integrations" / Upstash for Redis rather than a standalone "Vercel KV" product — same functionality, just check current naming). Then pull the generated env vars locally:

```bash
npx vercel link
npx vercel env pull .env.local
```

If `vercel link`/`env pull` isn't set up yet, manually copy `KV_REST_API_URL` and `KV_REST_API_TOKEN` from the dashboard into `.env.local`. Confirm `.env.local` is covered by `.gitignore` (the scaffolded one from Task 1 already includes `.env*.local` — verify, don't duplicate).

- [x] **Step 2: Install the client**

```bash
npm install @vercel/kv
```

- [x] **Step 3: Write the Server Action**

```typescript
// web/app/actions/games.ts
"use server";
import { kv } from "@vercel/kv";
import { randomUUID } from "crypto";

export interface GameRecord {
  id: string;
  mode: "model-1v1" | "user-1v1";
  white: { type: string; label: string };
  black: { type: string; label: string };
  moves: string[];
  result: "1-0" | "0-1" | "1/2-1/2";
  endReason: string;
  timestamp: number;
}

export async function saveGame(game: Omit<GameRecord, "id" | "timestamp">): Promise<void> {
  const id = randomUUID();
  const timestamp = Date.now();
  const record: GameRecord = { id, timestamp, ...game };

  await kv.set(`game:${id}`, record);
  await kv.zadd("games:index", { score: timestamp, member: id });
}
```

- [x] **Step 4: Wire it into the Model 1v1 page**

In `web/app/model-1v1/page.tsx`, uncomment the `import { saveGame }` line and the `await saveGame({...})` block from Task 8. *(Done, with one change: the import comes from `@/lib/games/store` — the facade — not `@/app/actions/games` directly. Task 10 should do the same.)*

- [x] **Step 5: Manual verification**

`npm run dev`, play a Model 1v1 game to completion, then check the Vercel KV dashboard (or `npx vercel kv` CLI tooling, or a quick scratch script calling `kv.get`) for a new `game:<uuid>` key with the expected shape and a corresponding entry in `games:index`. *(Ran against the localStorage adapter instead — no store exists to check a dashboard for. Verified via headless-Chrome CDP on the production build: full game, record present in `localStorage["er:games"]` with the right shape, and on /history. The KV dashboard check above is still owed the first time the flag flips.)*

- [x] **Step 6: Commit**

```bash
git add web/app/actions/games.ts web/app/model-1v1/page.tsx package.json package-lock.json
git commit -m "log finished games to kv"
```

#### What differed from the original plan

The one-line version: **the spec called for KV-only storage, and KV cannot be
turned on from a terminal.** Provisioning the store is Vercel dashboard work
under the owner's GitHub login; there was no `.vercel` dir, no `.env.local`,
and no `KV_REST_API_*` vars anywhere when this task started. Writing the
KV-only version as specced would have shipped a /history page that errors (or
shows nothing) on the live site until someone clicks through the dashboard.

So the storage went behind an adapter interface, decided deliberately (not
relitigating the spec's schema — the KV side implements it exactly):

- **`web/lib/games/types.ts`** owns `GameRecord`/`NewGameRecord`. The plan had the
  type exported from `web/app/actions/games.ts` — that can't work once you need it
  in client components: a `"use server"` module may only export async
  functions. Any future code wanting these shapes imports them from here.
- **`web/lib/games/localStore.ts`** — localStorage adapter, works with nothing
  provisioned. Per-browser records, capped at 50, pruned oldest-first (an
  unbounded key in a store you never trim is a slow-motion bug). Handles
  corrupt JSON by starting over rather than crashing the page.
- **`web/app/actions/games.ts`** — the KV adapter, still `"use server"`, still
  `game:{id}` + `games:index` ZADD / ZRANGE-REV + MGET per the design doc. Two
  robustness changes from the snippet: the client is built lazily via
  `createClient` (accepting `KV_REST_API_*` **or** `UPSTASH_REDIS_REST_*`,
  since the marketplace integration names vary by flow), and the action does a
  cheap shape-check before writing, because a Server Action is a public POST
  endpoint on the live site.
- **`web/lib/games/store.ts`** — the `saveGame`/`listGames` facade screens call.
  Branches on `NEXT_PUBLIC_KV_ENABLED === "1"` — it must be `NEXT_PUBLIC_`
  because the branch runs in the browser where server env vars don't exist,
  and Next inlines those at build time (so flipping it means redeploying).
  `saveGame` never throws: quota, private browsing, or a KV outage costs one
  log entry and a console warning, never the result screen (spec's own error
  handling rule, made structural).

**The KV adapter is untested against a real store, because none exists.** It
compiles, it's reachable, it follows the documented API — that's all that can
honestly be claimed. The switch-on runbook (provision → env vars →
`NEXT_PUBLIC_KV_ENABLED=1` → redeploy → play one game and check) is
docs/deployment.md §3, written to be followable without reading the code.

Also: `@vercel/kv@3.0.0` went in as planned, and the whole flow was verified
on the production build with the same headless-Chrome CDP approach as Tasks 2
and 8 (empty state → game → /history row → reload persistence → second game →
ordering, all green, no console errors).

---

## Phase 2 — User 1v1

### Task 10: User 1v1 page

**Done — `web/app/user-1v1/page.tsx`, plus a one-word export change in
`web/lib/chess/gameLoop.ts` and a grammar fix in `web/components/ResultScreen.tsx`.**
Do not build from the snippet below — it has four real bugs, listed under
"What differed" at the end of this task. Styled with the Ink & Bone tokens,
same two-column layout as Model 1v1 (controls + move log left, board right,
`er-lamp` thinking indicator while the engine searches).

Reuses `Board` (interactive mode), `EngineConfigPicker`, `ResultScreen`, and `saveGame` — no new shared components needed.

**Files:**
- Create: `web/app/user-1v1/page.tsx`

**Interfaces:**
- Consumes: `Board`, `EngineConfigPicker`, `ResultScreen` (Task 7, Task 8), `ALL_ENGINE_PRESETS`, `getMoveFor` (Task 4), `saveGame` (Task 9)

- [x] **Step 1: Write the page**

```tsx
// web/app/user-1v1/page.tsx
"use client";
import { useState } from "react";
import { Chess } from "chess.js";
import { Board } from "@/components/Board";
import { EngineConfigPicker } from "@/components/EngineConfigPicker";
import { ResultScreen } from "@/components/ResultScreen";
import { ALL_ENGINE_PRESETS, getMoveFor } from "@/lib/chess/engines";
import type { EngineConfig } from "@/lib/chess/types";
import { saveGame } from "@/app/actions/games";

type EndState = { result: "1-0" | "0-1" | "1/2-1/2"; endReason: string } | null;

export default function User1v1Page() {
  const [engine, setEngine] = useState<EngineConfig | null>(null);
  const [userColor, setUserColor] = useState<"white" | "black">("white");
  const [game, setGame] = useState(new Chess());
  const [fen, setFen] = useState(game.fen());
  const [started, setStarted] = useState(false);
  const [end, setEnd] = useState<EndState>(null);
  const [busy, setBusy] = useState(false);

  function start() {
    if (!engine) return;
    const fresh = new Chess();
    setGame(fresh);
    setFen(fresh.fen());
    setEnd(null);
    setStarted(true);
    if (userColor === "black") void engineReply(fresh);
  }

  function checkEnd(chess: Chess): boolean {
    if (!chess.isGameOver()) return false;

    let result: "1-0" | "0-1" | "1/2-1/2" = "1/2-1/2";
    let endReason = "draw-50move";
    if (chess.isCheckmate()) {
      result = chess.turn() === "w" ? "0-1" : "1-0";
      endReason = "checkmate";
    } else if (chess.isStalemate()) endReason = "stalemate";
    else if (chess.isThreefoldRepetition()) endReason = "draw-repetition";
    else if (chess.isInsufficientMaterial()) endReason = "draw-insufficient";

    setEnd({ result, endReason });
    void saveGame({
      mode: "user-1v1",
      white:
        userColor === "white" ? { type: "human", label: "You" } : { type: engine!.type, label: engine!.label },
      black:
        userColor === "black" ? { type: "human", label: "You" } : { type: engine!.type, label: engine!.label },
      moves: chess.history(),
      result,
      endReason,
    });
    return true;
  }

  async function engineReply(chess: Chess) {
    if (!engine) return;
    setBusy(true);
    const move = await getMoveFor(chess.fen(), engine);
    const applied = chess.move({ from: move.from, to: move.to, promotion: move.promotion });
    if (!applied) {
      // Same defensive fallback as gameLoop.ts (Task 6): chess.js stays authoritative,
      // an engine returning something outside chess.moves() falls back to a random legal move
      // instead of silently failing to advance the turn.
      const legal = chess.moves({ verbose: true });
      const fallback = legal[Math.floor(Math.random() * legal.length)];
      chess.move({ from: fallback.from, to: fallback.to, promotion: fallback.promotion });
    }
    setFen(chess.fen());
    setBusy(false);
    checkEnd(chess);
  }

  function onPieceDrop(from: string, to: string): boolean {
    if (!started || busy || end) return false;
    const isUserTurn = (game.turn() === "w") === (userColor === "white");
    if (!isUserTurn) return false;

    const move = game.move({ from, to, promotion: "q" });
    if (!move) return false;
    setFen(game.fen());

    if (!checkEnd(game)) void engineReply(game);
    return true;
  }

  return (
    <main style={{ display: "flex", flexDirection: "column", gap: "1rem", padding: "2rem" }}>
      <h1>User 1v1</h1>
      {!started && (
        <>
          <EngineConfigPicker presets={ALL_ENGINE_PRESETS} value={engine} onChange={setEngine} label="Opponent" />
          <label>
            Color
            <select value={userColor} onChange={(e) => setUserColor(e.target.value as "white" | "black")}>
              <option value="white">White</option>
              <option value="black">Black</option>
            </select>
          </label>
          <button onClick={start} disabled={!engine}>
            Start game
          </button>
        </>
      )}
      {started && (
        <Board fen={fen} interactive={!busy && !end} onPieceDrop={onPieceDrop} orientation={userColor} />
      )}
      {end && (
        <ResultScreen
          result={end.result}
          endReason={end.endReason}
          whiteLabel={userColor === "white" ? "You" : engine?.label ?? "Engine"}
          blackLabel={userColor === "black" ? "You" : engine?.label ?? "Engine"}
          onRematch={start}
        />
      )}
    </main>
  );
}
```

- [x] **Step 2: Manual verification**

`npm run dev`, visit `/user-1v1`, pick Stockfish 1320, play as White, drag a piece, confirm the engine replies (board updates after a short pause), play through to a game end, confirm the result screen appears and a new record shows up in KV (same check as Task 9 Step 5). Repeat once as Black to confirm the engine moves first correctly.

What actually ran (production build on `npm run start`, driven headless over CDP
with real `Input.dispatchMouseEvent` drags — see the harness note below):

- As White vs Stockfish 1320: dragged e2→e4, the ply counter registered it, the
  thinking lamp appeared, and the engine answered within a second.
- Illegal drags rejected with the ply count unchanged: Ke1→e3, and dragging the
  engine's own pawn.
- As Black: the engine opened unprompted and the board rendered black-oriented.
- One **complete game played through the UI** (random legal moves vs Stockfish
  2800): ended `0-1 · by checkmate`, card credited "Stockfish 2800 wins",
  cross-checked against an independent chess.js replay of the move log. The
  random mover even promoted (`fxg1=Q+`), exercising the auto-queen path.
- `describeEnd` additionally driven directly against six known terminal
  positions (both mate colours, stalemate, insufficient material, fifty-move,
  threefold) since one played game can only ever reach one `endReason`.
- Zero console errors/warnings across all runs.
- **The Vercel preview could not be screen-verified**: preview deployments are
  SSO-gated (Deployment Protection, see `deployment.md` §2), and this machine
  holds no Vercel credentials — the same wall PR #8 documented. Vercel's build
  for the branch is green; the rendered screen was only confirmed on the local
  production build.

- [x] **Step 3: Commit**

```bash
git add web/app/user-1v1
git commit -m "build the user vs engine screen"
```

#### What differed from the original plan

The snippet above is a first draft with four real bugs — the shipped page is
the reference, not the snippet:

1. **chess.js 1.x `move()` throws on an illegal move — it does not return
   `null`.** The snippet's `if (!move) return false` and `if (!applied)`
   branches are dead code: a user's illegal drop would have crashed the drop
   handler instead of snapping the piece back, and a bad engine move would have
   killed the game instead of falling back. Both paths are `try`/`catch` now —
   the same correction Task 6 already documented for the game loop.
2. **End detection is not duplicated.** The snippet's `checkEnd` re-implements
   `describeEnd`; instead `web/lib/chess/gameLoop.ts` now exports `describeEnd`
   (that's the whole gameLoop diff) and the page calls it. One source of truth
   for how a finished position maps to result/reason.
3. **The `Chess` instance lives in a `useRef`, not `useState`.** The snippet
   holds it in state and mutates it — mutation doesn't trigger a render, and
   under React 19 StrictMode's double invocation that's a latent bug. The UI
   renders from a separate `fen` state string; the ref is the source of truth.
4. **The snippet's `saveGame` import doesn't compile** — `web/app/actions/games.ts`
   is Task 9, which was in flight in a parallel lane when this shipped. The call
   is written out but commented, Task 8-style, with the exact payload shape
   ready to uncomment. *(Since wired: Task 9 landed right after this did, and a
   follow-up PR uncommented the block, importing from `@/lib/games/store`.)*

Beyond the bug fixes:

- **An in-flight engine reply is cancelled on unmount and restart** via an
  `AbortController`, mirroring the Model 1v1 page. The worker is shared and
  takes ~500ms per reply; without this a stale reply lands on the next game.
- **Restart is allowed mid-game** (the button relabels Start game → Restart →
  Play again). A human game, unlike a model game, can otherwise strand you with
  no way out short of leaving the page. The abort handling is what makes this
  safe.
- **Promotion is auto-queen** (`promotion: "q"`). No under-promotion picker in
  this MVP — known, deliberate limitation.
- **`ResultScreen` got a two-line grammar fix**: the human side is labelled
  "You", and the card said "You wins". It now special-cases that label to "You
  win"; engine labels are untouched.
- **CDP harness for interactive pages:** `web/scripts/cdp-model-1v1.mjs` only
  clicks a button; this page needed real drags. The adaptation that worked:
  dnd-kit's PointerSensor (react-chessboard v5, 1px activation distance)
  responds fine to `Input.dispatchMouseEvent` sequences (pressed → a few
  interpolated moves → released), and squares are addressable via
  `[data-square="e2"]`. React-controlled `<select>`s need the native value
  setter + a bubbling `change` event; setting `.value` directly is ignored.

---

## Phase 3 — History page

### Task 11: List past games

**Done — `#11`, same PR as Task 9** (they were built together — Task 9's
adapter decision reshapes this page, and /history being a 404 from the live
landing page was the visible problem both tasks exist to fix). Done out of
order versus Task 10 with the owner's explicit go-ahead; the snippets below
show the original server-component shape, superseded by "What differed" at the
end of this task.

**Files (as actually built):**
- Modify: `web/app/actions/games.ts` (add `listGamesKv`) + `web/lib/games/store.ts`/`localStore.ts` (the `listGames` facade + local read)
- Create: `web/app/history/page.tsx`

**Interfaces:**
- Consumes: `GameRecord` (Task 9)
- Produces: `listGames(limit?: number) => Promise<GameRecord[]>`

- [x] **Step 1: Add `listGames` to the Server Action file**

```typescript
// web/app/actions/games.ts (append to the existing file from Task 9)
export async function listGames(limit = 20): Promise<GameRecord[]> {
  const ids = await kv.zrange<string[]>("games:index", 0, limit - 1, { rev: true });
  if (ids.length === 0) return [];
  const records = await Promise.all(ids.map((id) => kv.get<GameRecord>(`game:${id}`)));
  return records.filter((r): r is GameRecord => r !== null);
}
```

- [x] **Step 2: History page**

```tsx
// web/app/history/page.tsx
import { listGames } from "@/app/actions/games";

export default async function HistoryPage() {
  const games = await listGames(20);

  return (
    <main style={{ padding: "2rem" }}>
      <h1>Game history</h1>
      {games.length === 0 && <p>No games yet.</p>}
      <ul>
        {games.map((g) => (
          <li key={g.id}>
            {g.white.label} vs {g.black.label} — {g.result} ({g.endReason}) —{" "}
            {new Date(g.timestamp).toLocaleString()}
          </li>
        ))}
      </ul>
    </main>
  );
}
```

- [x] **Step 3: Manual verification**

Having already played a few games in Phase 1/2, visit `/history` and confirm entries appear newest-first with correct labels, results, and timestamps. *(Done via headless-Chrome CDP against the production build: empty state on a fresh profile, then one game → correct row, reload → still there, second game → 2 records newest-first, matching localStorage order exactly. No console errors.)*

- [x] **Step 4: Commit**

```bash
git add web/app/actions/games.ts web/app/history
git commit -m "add the game history page"
```

#### What differed from the original plan

- **The page is a `"use client"` component, not an async server component.**
  Task 9's storage runs on localStorage until KV is provisioned, and
  localStorage only exists in the browser — a server component can't read it.
  The page fetches through the `listGames` facade in a `useEffect` and renders
  loading / empty / list states client-side. When the KV flag flips, the same
  RPC-stub import reaches the Server Action; the page doesn't change.
- **No `export const dynamic = "force-dynamic"`.** deployment.md §4 used to
  demand it for this page; that advice targeted the server-component shape.
  A client page prerenders as an empty shell with no data baked in, so there's
  nothing to go stale. The §4 note has been corrected rather than left
  misleading (it still applies if anyone rebuilds this as a KV-reading server
  component).
- **The page says what it's showing.** localStorage history is per-browser —
  presenting it as a global ledger would lie to a judge opening the demo
  fresh. The header reads "Local ledger · games played in this browser only",
  and flips to "Shared archive · logged from every visitor" when
  `NEXT_PUBLIC_KV_ENABLED=1`.
- **`listGames` reads 50, not 20** (matching the localStorage cap), still
  ZRANGE-REV + one MGET on the KV side per the design doc, and it never throws
  — a broken store renders as an empty history with the error in the console,
  not a crashed page.
- Follow-up owed by whoever lands Task 10: wire `saveGame` from
  `@/lib/games/store` into `web/app/user-1v1/page.tsx`, mirroring the call in
  `web/app/model-1v1/page.tsx`. (If that page landed before this PR merged, it was
  wired here instead — check the PR body.) *Done — both PRs merged within
  minutes of each other with the wiring still pending, so it landed as its own
  tiny follow-up PR right after: uncommented the Task-8-style block and pointed
  the import at the facade.*

---

---

## Task 12: Fight FX (added 2026-08-04, outside the original plan)

Not in the original plan — asked for after Phase 3 landed. Anime-fight effects
over both game boards, built as a tiered beat system rather than per-screen
animation code. Full write-up: [`docs/design/fight-fx-notes.md`](../design/fight-fx-notes.md).

**Files:**
- Create: `web/lib/fx/{types,classify,openings,effects,runtime}.ts`
- Create: `web/components/fx/{FxStage.tsx,fx.css}`
- Create: `web/app/dev/fx-lab/page.tsx` (disposable picker — safe to delete)
- Modify: `web/lib/chess/gameLoop.ts` (verbose move in `onMove`, per-ply pause hook),
  `web/lib/chess/engines.ts` (`onInfo` passthrough + `parseSearchDepth`),
  `web/app/model-1v1/page.tsx`, `web/app/user-1v1/page.tsx`

- [x] All 19 effects built and individually confirmed firing in the lab over CDP
- [x] Tier ladder + hit-stop wired through `runModelGame`
- [x] Both screens wired, two profiles (`spectate` full, `play` muted engine)
- [x] `prefers-reduced-motion` and `?fx=off` opt-outs
- [ ] **Browser verification of the two game screens** — cut for time on the
      merge. `tsc`/`eslint`/production build are green, but the drag path on
      `/user-1v1` was never exercised in a browser. First thing to check if
      drags misbehave is the overlay's `pointer-events: none`.

*(Since closed by Task 13, which drives `/user-1v1`'s drag path in headless
Chrome for 11 player moves — see `web/scripts/cdp-rating-readout.mjs`.)*

---

## Task 13: Bayesian rating inference (added 2026-08-05, outside the original plan)

Not in the original plan — the first of the five 2026-08-05 stretch specs, picked
for highest demo payoff at lowest risk (`docs/specs/2026-08-05-build-priority.md`).
Infers the player's rating live from their own moves: a posterior over Maia's 9
rating buckets that widens or narrows honestly instead of naming a number.
Spec: [`docs/specs/2026-08-05-bayesian-rating-inference.md`](../specs/2026-08-05-bayesian-rating-inference.md).

**Files:**
- Create: `web/lib/analysis/{maiaLikelihood,ratingPosterior}.ts`
- Create: `web/components/RatingReadout.tsx`
- Create: `web/app/dev/rating-test/page.tsx`, `web/scripts/cdp-rating-readout.mjs`
- Modify: `web/lib/chess/engineMaia.ts` (`evaluateMaiaAt` + one ORT run at a time),
  `web/app/user-1v1/page.tsx`

- [x] `evaluateMaiaAt(fen, selfCategory, oppoCategory)`; `evaluateMaia` is now a
      two-line wrapper over it, so `getMaiaMove` and the game loop are unchanged
- [x] Likelihood, mutual-information weighting, log-posterior accumulation,
      credible interval, `resolveOppoBucket`
- [x] Readout on `/user-1v1`, gated so it never names a bucket bare
- [x] All five of the spec's verification checks, plus an evidence ceiling and an
      arg-max fixture that aren't in it
- [x] Driven in a real browser: 11 player moves against Maia 1500, no console
      errors, gate opened on move 8

### What differed from the spec

**Three of its constants were wrong, and `I_min`/`I_ref` were wrong by an order
of magnitude in units.** The spec guessed `I_min = 0.02`, `I_ref = 0.25` nats.
Measured across a 40-ply game, real `I(fen)` runs min 0.001, p25 0.009, median
0.013, p75 0.026, max 0.085. At the spec's numbers 22 of 40 plies were skipped
outright, not one reached full weight, mean `g_t` was 0.07, and the posterior
finished 0.8 points off a flat prior — it read exactly like a broken estimator
and was only being told to ignore its own evidence. Shipped at `0.01` / `0.03`,
roughly the measured p25 and p75: mean `g_t` 0.48.

**The display gate is 6 effective plies, not ~3, and for a different reason.**
The spec ties it to interval width; the real problem is MAP stability. Over the
first six rated plies the MAP swings 1900 → 1400 → 1600, most of the width of the
scale, on almost no evidence. A gate at 3 puts a readout on screen that then
contradicts itself twice. Past 6 it holds 1600 for the rest of the game bar one
single-ply excursion in 30, while the band keeps visibly shrinking — which is
what the spec wants the UI to show. On the fixture the gate opens at rated ply
10; in the live browser run it opened on move 8, because those positions carried
more information per ply.

**`τ` stays at 0.35, but the honest justification is weaker than the spec's.**
The overconfidence tempering exists to prevent does not happen here: at `τ=1`
with every ply at full weight, 40 rated plies peak at 25.9% on a single bucket
and never cross 90%. Nine hypotheses this similar can't collapse. `τ` is cheap
insurance, not a load-bearing correction — measured, it buys one bucket of extra
interval width for no change in MAP.

**`evaluateMaiaAt`'s parameters are `selfCategory`/`oppoCategory`, not the spec's
`selfBucket`/`oppoBucket`.** `RatingBucket` in `lib/analysis` is a rating
(1100–1900) and these are the model's category indices (1–9). Both are `number`,
so one word covering both scales is a bug waiting to be written.

**One ORT run at a time, which the spec doesn't ask for.** It lists "whether
concurrent `session.run()` calls on one session even interleave safely" as
unverified. They don't — ORT throws `Session already started`. That's fine today
because the game loop is sequential, but the estimator's nine passes land right
on top of the opponent's own `getMaiaMove`, and if the opponent's call lost the
race `/user-1v1` would show "Engine failed" for a reason nothing in the game code
explains. `engineMaia.ts` serialises at the one point both callers pass through.
Costs a sequential caller one microtask; output is byte-identical.

**Verification is a dev page, not `scripts/verify-rating-posterior.mjs`.** It
can't be a Node script: `engineMaia.ts` throws "Maia runs in the browser only"
under Node and ORT resolves its wasm from `/ort/`. `/dev/rating-test` driven by
the existing `cdp-verify.mjs` is the same shape as the Maia spike's harness.

### Verification results actually observed

Production build, headless Chrome, fixture = Maia 1700's own moves against
Maia 1500 (so `oppoBucket` resolves exactly), 40 rated plies.

| Spec check | Result |
| --- | --- |
| 1. Self-consistency | **MAP 1600, one bucket off 1700.** Interval 1400–1900 covers the truth; `P(1700)` climbs 11.1% → 14.6%; `eff` 19.18/40. Second seed lands MAP 1800 — one bucket off the *other* way. |
| 2. One legal move | PASS, exact: `I(fen) = 0.000e+0`, `g_t = 0`, no branch needed |
| 3. No evidence, no claim | PASS on the part that matters — flat 1/9, `ready=false`. Interval spans **8** buckets, not the 9 the spec expects: seven flat buckets is 77.8% and eight is 88.9%, so 80% coverage stops at eight. |
| 4. Wrong `elo_oppo` | PASS. Scored with a deliberately wrong `oppoBucket` (1100) the MAP still lands on 1700 — "fix to a default" is safe in practice, marginalising isn't worth 9× |
| 5. Tempering by eye | Ran, but the effect the spec predicts isn't there — see `τ` above |

**Why MAP being one bucket off is not a tuning problem.** With no weighting and
no tempering at all (`g=1, τ=1`, the most this fixture can possibly claim) the
ceiling posterior is:

```
1100:0.5%  1200:1.4%  1300:4.8%  1400:21.1%  1500:18.9%  1600:25.2%  1700:15.4%  1800:9.1%  1900:3.6%
```

MAP 1600, truth ranked 4th. Adjacent buckets are genuinely unresolvable — Maia's
own per-move separation between neighbours is 1–3 points (`docs/maia-notes.md`).
What it *does* resolve is real: 65% of mass on 1400–1700, and the extremes ruled
out at under 1.5%. Two seeds bracketing 1700 from either side is the signature of
an unbiased estimator with about ±1 bucket of precision. The evidence-ceiling
diagnostic is in the page specifically so the next person doesn't respond to
"MAP is one bucket off" by cranking `τ` until it isn't, which would just be
fitting one fixture.

**Arg-max fixtures read as 1900, confidently.** Not in the spec's plan, and worth
knowing. Scoring moves generated by `getMaiaMove` (which takes the arg-max) gives
MAP 1900 with 69% on one bucket at the ceiling. Always playing the modal move
looks like a very *predictable* player, and predictability reads as high rating.
Doesn't affect real use — humans don't play arg-max — but it means pointing this
estimator at a Model 1v1 game would report nonsense.

**Live on the real screen.** `cdp-rating-readout.mjs`, Maia 1500 opponent, 11
player moves: readout held "reading your moves…" through move 7, opened at move 8
on 6.1 effective plies, never named a bucket without its interval. No console
errors and no `Session already started`, which is the serialisation doing its job.
The driver has no board model so it plays whatever's legal, which came out as
`a2a3 h2h3 b2b3 g2g3 a3a4 h3h4 b3b4` — aimless wing pawns — and the estimator
called it "plays most like a 1100 · likely 1100–1600". It's reading something real.

### Left undone

- [x] ~~Not verified on the live site.~~ **Done, after merge.** The preview URL is
      SSO-gated, but *production* is public, so `cdp-rating-readout.mjs` runs
      against it unchanged. 11 player moves on
      `the-engine-room-gold.vercel.app/user-1v1` against Maia 1500: readout held
      through move 7, opened on move 8 at 6.1 effective plies, never named a
      bucket bare, no console errors, no `Session already started`. Byte-identical
      to the local run, including the "plays most like a 1100 · likely 1100–1600"
      verdict on the driver's wing-pawn play.
- [ ] **`τ`, `I_min`, `I_ref` are tuned against one fixture pair.** Better than
      the spec's untested guesses, still one game's worth of data. A corpus of
      graded human games would settle them; there isn't one here.
- [ ] **Calibration still unaudited** (`2026-08-05-maia-calibration-audit.md`).
      Everything above assumes Maia's softmax behaves like a probability in
      `elo_self`. The wide interval is the hedge.
- [ ] **Still 9 sequential forward passes per ply (~400ms) on the main thread.**
      A Worker is the real fix and is out of this spec's scope; batching depends
      on the rollouts spec.

---

## Task 14: Maia Monte Carlo rollouts (added 2026-08-05, outside the original plan)

Spec: [`../specs/2026-08-05-maia-monte-carlo-rollouts.md`](../specs/2026-08-05-maia-monte-carlo-rollouts.md).
Second of the five 2026-08-05 stretch specs, in the order
[`../specs/2026-08-05-build-priority.md`](../specs/2026-08-05-build-priority.md)
sets out. Built on top of Task 13's branch rather than `main`, because it needs
the `evaluateMaiaAt` split that task introduced — the shared
legal-move-softmax extraction lives in the same function, and doing it twice is
how two copies of a decoder drift apart.

**How it was landed, since the stacking made it non-obvious.** `feat/14` was cut
from Task 13's branch and so carried all of Task 13's commits, which would have
made a PR against `main` show two features at once. So it waited for Task 13 to
squash-merge (`#23`) and then rebased *past* its own base rather than onto it:

```sh
git rebase --onto origin/main 5f5ace6 feat/14-maia-rollouts
```

That replays only the seven Task 14 commits. A plain `git rebase origin/main`
would have tried to reapply Task 13's four commits on top of the squash that
already contains them — the trap `docs/deployment.md` describes, where a
squash-merge leaves git unable to tell what has landed. The `5f5ace6` in that
command is Task 13's write-up commit, which another session committed onto this
branch by accident (`#24` tells that story) and which is the last commit whose
content `main` already had.

What made it safe to skip re-running the verification afterwards: `engineMaia.ts`
and `user-1v1/page.tsx` were byte-identical between the old base and `main`, so
the squash was exactly the code every check above ran against. Confirmed with
`git diff 48824f2 origin/main -- <those files>` before rebasing, not assumed.

Estimates a *human-realistic* win/draw/loss at a position: play it out N times
with Maia choosing every move for both sides, count how they ended. Flat Monte
Carlo, not MCTS — every rollout is an independent sample from the root, which is
what makes the intervals mean anything.

**Files:**
- Create: `web/lib/chess/maiaRollout.ts` (the rollout loop and the statistics)
- Create: `web/components/OddsReadout.tsx`
- Create: `web/app/dev/maia-rollout-test/page.tsx`
- Create: `web/scripts/probe-maia-graph.mjs` (graph questions, answered in Node)
- Create: `web/scripts/cdp-odds-readout.mjs` (the panel, driven in a browser)
- Modify: `web/lib/chess/engineMaia.ts` (`evaluateMaiaBatch`, `sampleFromPolicy`,
  `uciToMove`, and the decode both paths now share)
- Modify: `web/lib/chess/engines.ts` (`parseSearchScore`), `web/app/user-1v1/page.tsx`,
  `docs/maia-notes.md`, `docs/README.md`, `web/app/dev/README.md`

- [x] Batch axis spiked *before* anything was built on it, per the spec's own instruction
- [x] `evaluateMaiaBatch` + temperature sampler, with the softmax extracted, not forked
- [x] Rollout loop: lockstep passes, per-category Wilson intervals, value-bootstrapped truncation
- [x] Verification page, every check green, no console errors
- [x] On-demand readout on `/user-1v1`, driven in a real browser (not cut for time, unlike Task 12's)

#### The spike came first, and it changed the case for the feature

The spec called one thing its "single biggest unknown": whether the ONNX graph's
batch axis is dynamic or was exported hardcoded to 1. It's dynamic —
`session.inputMetadata` declares `boards: ["batch_size",18,8,8]` — and row *i* of
the `[N,1880]` output is **bit-identical** (0.000e+0, not merely close) to
evaluating that position alone.

But the spec was banking on batching being *faster*, and it isn't: **27.3ms per
position at N=1 against 24.2 at N=30.** About 10%, not a multiple. Full table in
`docs/maia-notes.md`. So the spec's "floor case" is simply the case, and the
reason to batch is that ~4,000 sequential awaits become ~40 — scheduling and code
shape, not wall clock. Budget any rollout as `Σ rollout lengths × ~25ms`.

Worth stressing that this took ten minutes in Node, before a line of the feature
existed. `onnxruntime-web`'s wasm backend runs outside a browser, so
`probe-maia-graph.mjs` answers graph questions without the 93 MB download the
browser pays on every load.

#### What differed from the spec

1. **Finished rollouts leave the batch instead of being masked.** The spec keeps
   the tensor at `[N,...]` and resubmits finished rows with the output discarded,
   avoiding compaction only because it "reopens the dynamic-batch-size question" —
   which the spike had just closed. Since total FLOPs are conserved, padding dead
   rows costs real time, so they get dropped instead.
2. **Ply budget 200, not 120** — and this one only became affordable *because* of
   (1). At 120, 17% of rollouts from an opening position were still running when
   the cap hit (mean game length 81 plies), so a sixth of the sample got scored by
   the value head's guesswork rather than played out — enough to trip the module's
   own "interval is compromised" flag. Extending to 200 costs about 10s on a 99s
   run, because only the 5 stragglers pay for the extra plies. Under the spec's
   fixed-shape batch the same extension would have cost 60s.
3. **The truncation bootstrap centres on a measured number, and the measurement
   nearly went the wrong way.** Sweeping `elo_self` moves `logits_value` by 0.88
   across the nine buckets — more than a queen of material — which reads as a
   rating-dependent bias needing a per-bucket centre. It isn't: that sweep pinned
   `elo_oppo` at 1500, so it was measuring a rating *gap*. With both inputs matched
   the sweep is flat to within 0.04, giving one honest constant (-0.047 over four
   level positions × nine matched tiers) and a rollout at mismatched tiers gets the
   gap priced in for free. The control mattered more than the measurement.
4. **Truncated rollouts are *sampled* from the value-implied distribution, not
   added as fractions.** Keeps the counts integers, so the Wilson intervals keep
   meaning "N independent draws", and the extra uncertainty widens the interval
   instead of hiding inside a confident-looking fractional count.
5. **The player's own tier comes from Task 13's rating read** when it has passed
   its display gate, falling back to 1500 with the readout saying which it used.
   The spec explicitly leaves this to the caller ("a preset tier, or whatever
   bayesian-rating-inference produces"); this is that composition.
6. **`parseSearchScore` added to `engines.ts`** — the spec flags it as a
   prerequisite for its own Stockfish comparison, since `parseSearchDepth` only
   ever pulled `depth` off the `info` stream.

#### Verification — observed, not asserted

`/dev/maia-rollout-test`, driven by the existing `cdp-verify.mjs` against a
production build. Every check green, zero console errors.

- **Batching:** three distinct positions (one black-to-move, so the mirroring path
  is uneven across rows) each matched their standalone evaluation to 0.00e+0 on
  both policy and value, and row 1 did *not* match position 0.
- **Sampler:** `T=0` returns the top move; `T=1` empirical frequencies track the
  policy to within 0.7 points over 6,000 draws (28.5% → 28.5%, 24.2% → 23.9%);
  `T=0.05` sampled the top move 95.4% of the time against the 96.4% the sharpened
  distribution implies.
- **Wilson:** all five hand-computed cases match, including 30/30 → [88.6%, 100%]
  where Wald would claim [100%, 100%].
- **Mate in 1:** Maia puts 98.1% on `a1a8` (Ra8#) and 30/30 rollouts won in a mean
  of 1.0 plies, in a single pass.
- **Perspective:** the same board with each side to move inverts cleanly — rook-up
  83.3% win / 0% loss, rook-down 0% win / 83.3% loss. This is the check that
  catches reading chess.js's `1-0` as the root mover's win.
- **Direction vs Stockfish:** cp +644 → 73.3% win, cp +23 → 46.7% *draw*, cp −628 →
  90.0% loss. Ranks identically; deliberately not a numeric match, and the +644
  position converting only 73% of the time is the whole point of the feature.
- **A realistic middlegame at the defaults:** win 43.3% [27.4–60.8%], draw 20.0%,
  loss 36.7% — 160 passes, mean 101.8 plies, **nothing truncated**, 83.7s. Note it
  came in *faster* than the same position under the 120-ply budget (99.3s) despite
  averaging 20 plies more per rollout: passes get cheap once most rows have left the
  batch, whereas the 120 run still had 25 of 30 alive at the cap, paying full width
  the whole way.
- **Mismatched tiers:** from that same position, 1100 against 1900 loses 86.7% where
  matched 1500s lose 36.7% — the clearest evidence that pulling `elo_self` and
  `elo_oppo` apart bought something real.
- **Regression:** `/dev/maia-test` passes end to end and reproduces the numbers
  `docs/maia-notes.md` recorded before this task existed (`g8f6` at 31.9/29.3/32.6%
  across the three tiers, start-position value −0.1813, `exd4` at 93.9%). That's
  what backs the claim that `evaluateMaia`/`getMaiaMove` behave exactly as they did
  before the decode was extracted out from under them.
- **The panel itself,** via `cdp-odds-readout.mjs` against a production build: real
  drags versus Stockfish 1320, then ask for the odds. All three outcomes appear each
  with its own interval, the sample size and both tiers are named — it read
  `MAIA 1500 VS 1300`, so the Stockfish-1320-to-1300-bucket rounding and the
  "rating read hasn't passed its gate yet, so use 1500" fallback both did what they
  should — and **moving a piece wiped the numbers**, which is the state that would
  otherwise be the most misleading thing on the page. No `Session already started`,
  so the rollouts and the live game shared one ORT session without colliding.

#### Still open

- **No Worker, so the main thread blocks in bursts** — roughly 730ms per full-width
  pass at N=30, once per ply. It yields between passes so progress paints, which
  doesn't make the bursts go away. `2026-08-05-engine-worker-pool.md` is the real fix and
  is out of this feature's scope.
- **Self-play distributional shift**, the spec's own biggest caveat and still
  unresolved: Maia imitates human-vs-human games, and chaining its samples back
  into itself for dozens of plies is an input distribution nobody has checked
  against real games. Treat these numbers as informative, not precise.
- **The value head is not monotone** — "about to be mated" reads *better* than
  "down a queen" (`docs/maia-notes.md`). The squashing is deliberately wide
  because of it, and no amount of care in this module fixes the underlying head.
- **N is fixed at 30** with no adaptive stopping, per the spec's scope. At 30 the
  worst-case interval is ±16.8 points, and halving that takes 4× the rollouts.

---

## Task 15: Policy mixture engine (added 2026-08-05, outside the original plan)

The third of the five 2026-08-05 stretch specs, and #3 in
`docs/specs/2026-08-05-build-priority.md`'s order. A fourth `EngineType` that
isn't a third model: Stockfish's `MultiPV` shortlist scored against Maia's policy,
`score(m) = α · winProb(cp_m) + β · log P_maia(m)`, arg-maxed or sampled through a
temperature. Both models run exactly as they already do; this is arithmetic on
their two outputs, which keeps it inside the no-training constraint by
construction. Spec:
[`docs/specs/2026-08-05-policy-mixture-engine.md`](../specs/2026-08-05-policy-mixture-engine.md).

**Files:**
- Create: `web/lib/chess/engineMixture.ts`
- Create: `web/app/dev/mixture-test/page.tsx`, `web/scripts/cdp-mixture-game.mjs`
- Modify: `web/lib/chess/types.ts` (`"mixture"` + 4 optional fields),
  `web/lib/chess/engineStockfish.ts` (`getStockfishLines`, and `MultiPV 1` set
  explicitly on every `getStockfishMove` call), `web/lib/chess/engines.ts`
  (dispatch, `MIXTURE_PRESETS`, `usesMaiaWeights`),
  `web/app/{model-1v1,user-1v1}/page.tsx`, `web/lib/analysis/ratingPosterior.ts`,
  `web/lib/games/types.ts`

- [x] `getStockfishLines(fen, config, multiPv, onInfo)` on the shared worker queue,
      returning per-line `cp`/`mate`/`depth` plus the raw `bestmove`
- [x] `buildCandidates` / `selectMixtureMove` / `evaluateMixture` / `getMixtureMove`,
      with the union rule, the epsilon floor and the temperature sampler
- [x] Dispatch arm, one preset, and `usesMaiaWeights` for the two lookalike checks
      that need opposite treatment
- [x] All three of the spec's falsifiable checks, plus the NaN case, the union
      case, mate ordering, and the two questions the spec left open
- [x] Driven end to end on /model-1v1 with the mixture on both sides

### What differed from the spec

**The mate-ordering scheme doesn't work, and the reason generalises.** The spec
maps mate distance to a synthetic cp of `100_000 - |mate|` and reuses the win-probability
logistic, on the stated reasoning that "the logistic saturates long before this;
sign + ordering are what matter". Sign survives. Ordering does not:
`exp(-0.00368 · 99_995)` underflows, so `winProb` returns *exactly* `1.0` for every
mate at every distance, mate-in-1 ties mate-in-5, and the stable sort quietly falls
back to Stockfish's multipv order. Replaced with a clamp plus a reserved band —
cp clamped to ±3000, mates mapped into `(3000, 4000]` by distance — which makes the
ordering real.

Real, and still not sufficient, which is the more useful finding: the margin between
mate-in-1 and mate-in-5 is ~6e-9 of win probability, while a `β · log P` difference
is order 1. **This engine does not guarantee it plays the fastest available mate**,
and no choice of constants fixes that, because a bounded win probability blended
against an unbounded log-probability will always lose the tail comparison. A hard
"a mate ends the game, skip the blend" override would fix it; it isn't built here
because it would break the α=0 verification check and deserves its own spec.

**β = 1 is two to three orders of magnitude past where the blend balances.** The
spec calls `1:1` a starting guess; it's further off than that suggests. On the start
position the choice flips from Stockfish's move to Maia's between β = 0.001 and
β = 0.01 and never flips back through β = 5. The exact crossover is β ≈ 0.0027, and
it's structural rather than positional: the logistic's slope at cp 0 is `k/4 ≈ 0.00092`
per centipawn, so two candidates 10cp apart differ by ~0.009 in win probability while
their Maia log-probabilities differ by ~2. At β = 1 the Stockfish term can only
reorder candidates whose policy probabilities sit within a factor of `e^(α/β) ≈ 2.7`
of each other. The preset still ships at 1:1, because 0.0027 without SPRT behind it
is just a better-informed guess — but it should be read as Maia-dominated, not
balanced. That crossover is calibration step 1's answer, and `/dev/mixture-test`
now prints it from the closed form.

**Both of the spec's flagged unknowns are now measured, and they went opposite ways.**

- *MultiPV costs real depth.* At the fixed 500ms movetime, `MultiPV=1` → `MultiPV=8`
  drops depth 17 → 12 on an open Italian and 20 → 14 on a closed middlegame. So a
  wider shortlist buys candidates by making every candidate's evaluation shallower,
  with nothing in the output marking it. `multiPv: 8` is kept as specified, but it
  isn't free and SPRT should sweep it.
- *`UCI_LimitStrength` does not corrupt the reported evals.* At `MultiPV=5`, uncapped
  and `UCI_Elo 1320` returned byte-identical cp across all five lines
  (`d2d4:38 f1b5:37 b1c3:21 f1c4:20 f1e2:-3`) while the `bestmove` token moved from
  `d2d4` to `a2a4`. Limit-strength picks a different line to play; it doesn't lie
  about what the lines are worth. One position, so not a proof — but it's direct
  evidence where the spec had an inference from one indirect data point, and it means
  the internal call's skipping of limit-strength is a clean-calibration choice rather
  than a workaround.

**`UCI_ShowWDL` is advertised by this build.** The spec named Stockfish's own
`info … wdl w d l` as the properly calibrated replacement for Lichess's fitted
constant and left "does this lite build have it" open. It does:
`option name UCI_ShowWDL type check default false`. So that follow-up has no
unknowns left in front of it. Not taken here, because it changes what α weights and
therefore wants its own before/after calibration.

**The preset draws against itself in 8 plies, and the obvious explanation is
wrong.** `1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8`, threefold repetition. The
tempting diagnosis is "T=0 makes both sides deterministic, so raise the temperature",
and it survives neither half of a measurement:

- *Raising T doesn't fix it.* Swept T = 0.25, 0.5 and 1 as temporary presets. 0.25
  and 0.5 draw at 8 plies exactly as T=0 does; T=1 finds a **different** 2-cycle
  (`3. Nc3 Nc6 4. Nb1 Nb8`) and draws at 12. Sampling changes which cycle, not
  whether there is one.
- *The mixture didn't introduce it.* **Maia 1500 and Maia 1100 self-play produce the
  identical Nf3/Ng1 shuffle and the identical 8-ply threefold** on this build. At
  β=1 the blend is Maia-dominated, so this is inherited, faithfully. It has presumably
  been true of Maia-vs-Maia since Task 3 and gone unnoticed because /model-1v1
  defaults to Stockfish 1320 vs 2800.

Root cause is in the model, not the blend: Maia 2's input carries no move-history
planes, so after `1. Nf3 Nf6` it cannot see that it just played Nf3. A history-free
policy played greedily, over a position pair where each move's inverse is also
well-liked, is a 2-cycle attractor. Written up in `docs/maia-notes.md`, where it
belongs. `temperature: 0` therefore stays as specified, and the real cure is the
randomized opening book in `2026-08-05-sprt-engine-ratings.md` — which exists for
precisely this and replaces engine choice for the first K plies.

Worth recording as a process note too: the first draft of this section confidently
blamed determinism and recommended `T > 0`. One sweep and one Maia-vs-Maia control
run falsified both claims. The control run is the part that mattered — without it
this would have shipped as a mixture bug with a fix that doesn't work.

**The spec's consumer audit missed one site, because Task 13 post-dates the spec.**
`resolveOppoBucket` in `web/lib/analysis/ratingPosterior.ts` read
`type === "maia" ? ratingTier : elo`, which sends a mixture config down the `elo`
branch to `undefined` and silently defaults it to 1500 — wrong, since a mixture
config's `ratingTier` is already on Maia's scale exactly. Fixed as
`ratingTier ?? elo` rather than by importing `usesMaiaWeights`: that module is pure
math, and importing the engine registry would drag `onnxruntime-web` into it and
break the plain-Node runnability `2026-08-05-sprt-engine-ratings.md` is counting on.

**`uciToMove` briefly wasn't on `main`.** The spec's illustrative code imports it
from `engineMaia.ts`, but it's a Task 14 addition and `#25` was still open while this
was built, so the first pass exported `parseUciMove` — the same four lines, already
private in `engineStockfish.ts` — rather than add a second copy that would collide
on merge. `#25` has since merged, so this branch was rebased onto it and the
workaround dropped: `engineMixture` imports `uciToMove` as the spec always intended
and `parseUciMove` is private again. The two remain near-duplicates of each other in
their respective modules, which is pre-existing and small enough to leave alone.

**One guard earned its keep immediately.** `evaluateMixture` throws when Stockfish
reports zero scored lines at a position that has legal moves, because the union rule
means a broken MultiPV parse would otherwise leave Maia's favourite as the only
candidate and degrade the whole engine to plain Maia — still returning legal moves,
still looking like it works. It fired on the first verification run, on a test FEN of
mine with the two kings adjacent: chess.js reported a legal move for the illegal
position while Stockfish answered `bestmove (none)`. Two of the ten corpus FENs were
wrong that way (the other was Fool's Mate, i.e. zero legal moves rather than "few").

**`cp`-argmax and `multipv 1` can disagree.** Seen once, on a quiet Italian position
at `MultiPV=8`, where rank 1 reported cp 25 and rank 3 reported cp 27 — the
depth-inequality risk the spec lists, since the lines don't finish at equal depths.
Rare rather than routine: 7/7 agreement across the C1 corpus. So the β=0 check asserts
on the mixture's own contract (the highest-cp candidate) and *reports* multipv-1
agreement with the depths alongside, instead of asserting on something that can
honestly differ.

### Left undone

- [ ] **No strength claim exists, by design.** Nothing here says how strong this
      engine is; `2026-08-05-sprt-engine-ratings.md`'s harness is the only thing that
      could, and it hasn't run. The preset label deliberately carries no number.
- [ ] **β, `multiPv` and T are all uncalibrated.** The crossover analysis narrows β
      to O(0.001-0.01) and the depth measurement argues against a wide `multiPv`, but
      narrowing is not choosing.
- [ ] **`UCI_ShowWDL` not adopted** — confirmed available, not wired up.
- [ ] **No fastest-mate guarantee**, per above.
- [ ] **The limit-strength × MultiPV result is one position.** Consistent with the
      documented behaviour, but a sweep would settle it properly.
---

## Task 17: Maia calibration audit (added 2026-08-05, outside the original plan)

Spec: [`../specs/2026-08-05-maia-calibration-audit.md`](../specs/2026-08-05-maia-calibration-audit.md).
Fifth of the five 2026-08-05 stretch specs, and the one
[`../specs/2026-08-05-build-priority.md`](../specs/2026-08-05-build-priority.md)
puts last precisely because it "never touches the app" — a slide you show a
judge, not something they click. It answers whether the *number* Maia attaches to
a move can be trusted, which two shipped features (Tasks 13 and 14) already read
as though it can. Results: [`../maia-calibration-notes.md`](../maia-calibration-notes.md).

Built out of order: Tasks 15 (policy mixture) and 16 (SPRT) were both claimed by
other lanes, so this was the next unclaimed spec. It shares no source files with
either, so the ordering costs nothing.

**Files:**
- Create: `web/scripts/build-maia-calibration-fixture.mjs`, `web/scripts/audit-maia-calibration.mjs`
- Create: `web/scripts/verify-calibration-harness.mjs`, `web/scripts/verify-calibration-fixture.mjs`
- Create: `web/scripts/lib/{calibration,maiaNode}.mjs`
- Create: `web/scripts/fixtures/maia-calibration-{sample.jsonl,spotcheck.json,report.json}`
- Create: `docs/maia-calibration-notes.md`
- Modify: `web/lib/chess/engineMaia.ts` (two `export` keywords, no behaviour change),
  `docs/specs/2026-08-05-maia-calibration-audit.md`, `docs/README.md`

- [x] Harness validated on synthetic predictors with known answers *before* Maia
- [x] 3,964-row CC0 Lichess rapid corpus, every row invariant-checked, 10 re-derived from raw PGN
- [x] Self-consistency gate green, then the real pass: all five of the spec's checks
- [x] The `elo_oppo` question `bayesian-rating-inference.md` left open, answered
- [x] Held-out temperature fit, measured and written down, deliberately not wired in

### What it found

**Maia is mildly and systematically overconfident about its top move.** Top-1
accuracy 50.0%, exactly the published figure. Pooled over every (position, legal
move) pair ECE is 0.0028 — but that is dominated by the ~90% of pairs carrying
under 1% of the mass. Restricted to the model's own favourite move, ECE is
**0.036**, and **all ten bins come in below the line** — at a quoted 84% humans
play the move 73% of the time. A held-out temperature fit lands at **T = 1.129**,
the same conclusion from the other direction, and applying it cuts held-out ECE
by 61% without touching accuracy.

Directly useful downstream: scoring the corpus with the true opponent rating
instead of `elo_oppo = elo_self` moves log loss by **0.00116 nats**, so
`bayesian-rating-inference.md`'s cheap fixed default is safe and marginalising
`elo_oppo` would buy nothing for 9× the passes.

### What differed from the spec

1. **`onnxruntime-web`, not `onnxruntime-node`.** The spec recommends the native
   package; the wasm backend runs fine under Node — Task 14's
   `probe-maia-graph.mjs` had already shown that — and it is what the app ships,
   so the audit measures the deployed runtime instead of a second one. Avoids a
   native build, which the spec's own Risks call the likeliest install failure
   on this machine.
2. **Two exports added to `engineMaia.ts`.** The spec says to import the encoder
   rather than reimplement it, and names the four pure helpers — but
   `legalPolicyIndices` and `decodePolicy`, where "which slots are legal" and
   "softmax over just those" live, were module-private. A keyword each. This is
   the only app-code change in the task and it alters no behaviour; `npm run
   build` green.
3. **The zstd trap is not the one the spec predicted.** It worried about needing
   a zstd dependency on Node 20; the machine runs Node 24.16, so `zlib` has it
   built in. The actual trap: Lichess writes the dumps in seekable-zstd layout,
   so the file opens with a **skippable frame** that Node's decompressor does not
   skip — fed as-is it emits **zero bytes and no error**, which looks exactly
   like a month with no rapid games. Also, it stops at the first frame boundary,
   capping a run at ~14,000 games (~4,000 rows), which is documented and warned
   about rather than fixed.
4. **A third synthetic check, not in the spec's list:** that the temperature fit
   recovers distortions it was not told about (injected ×1.6 → fitted 1.583,
   ×0.6 → 0.593). The spec proposes temperature scaling as the remedy without
   ever validating the machinery; applying an unvalidated correction to a real
   model is how you launder a bug into a result.
5. **Check 4 covers all 3,964 rows, not ~10.** The spec asks for a hand
   spot-check of ten rows against raw PGN. That still happens — by a deliberately
   independent naive replay — but the cheap invariants (move legal at stored FEN,
   side-to-move matches ply parity, no duplicate `(game, ply)`) run over the
   whole file for a second's compute, and the parity check is the actual
   off-by-one detector.
6. **The fixture carries `ply` and `game` beyond the spec's four fields.** Both
   exist to make check 4 possible: `ply` parity is what catches an off-by-one,
   `game` is provenance.

### Still open

- **The per-bucket temperatures look different but the sample can't support it**
  (spread 0.338 across nine fits of ~167 rows each, no monotone trend in rating).
  The script's automatic "buckets genuinely differ" verdict fires on a guessed
  threshold and is called out in the notes as not-to-be-believed. One global T is
  what the data supports.
- **T = 1.129 is measured, not applied.** Landing it inside `evaluateMaiaAt` is
  explicitly out of the spec's scope, and the effect is small enough that there's
  no urgency. That is the one hook where both the game loop and the rating
  estimator would inherit it.
- **The effect on Task 13's 80% credible interval is reasoned, not measured** — a
  global rescale largely cancels in a bucket-to-bucket likelihood ratio, but
  nobody has run the estimator with and without the correction.
- **One month, one site, first ~14,000 games.** Not a uniform draw from the
  month, and Lichess rapid is a self-selected population.
## Task 16: SPRT engine ratings (added 2026-08-05, outside the original plan)

Spec: [`../specs/2026-08-05-sprt-engine-ratings.md`](../specs/2026-08-05-sprt-engine-ratings.md).
Fourth of the five 2026-08-05 stretch specs. Task 15 (the policy mixture) was
running in a parallel lane, so this was cut from `main` rather than stacked on
it — nothing here touches the files that task edits.

Measures what the presets are actually worth, instead of what their dropdown
labels claim. Closes an admission that has been sitting in Task 2 since the
Stockfish spike:

> Depth does not vary with ELO (13 at both 1320 and 2800)... this spike proves
> the options are accepted and the engine searches; it does **not** prove the
> ELO settings change playing strength.

Results, and how to read them: [`../rating-notes.md`](../rating-notes.md).

**Files:**
- Create: `web/lib/analysis/{types,eloModel,sprt,ratingBT,ratingGlicko2,openingBook,matchRunner}.ts`
- Create: `web/lib/analysis/fixtures/{games-log.jsonl,ratings.json}`
- Create: `web/app/dev/match-runner/page.tsx`
- Create: `web/scripts/{verify-analysis-math.mjs,sprt-run.mjs,ts-extension-resolver.mjs}`
- Modify: `web/lib/chess/gameLoop.ts` (one optional `startFen`), `web/app/dev/README.md`,
  `docs/deployment.md`, `docs/README.md`

- [x] Davidson-extended Bradley-Terry fit, Wald SPRT, Glicko-2, all pure
- [x] Randomized opening book — 21 lines, checked legal *and* non-transposing
- [x] `verify-analysis-math.mjs`: 55 checks under plain Node, no browser, no engine
- [x] Match runner on `/dev/match-runner`, driven by `sprt-run.mjs`
- [x] Real matches played, fixture committed

### What differed from the spec

**Ford's condition is checked structurally, before fitting — not caught
afterwards as a bad iterate.** The spec says to "detect a diverging/NaN iterate
and report insufficient connectivity". Detecting it up front is strictly better:
there is no divergence to catch, and the report can name *which* preset and
*why*. A preset that swept its games and a preset in a disconnected engine
family both fail the MLE's existence condition, but for opposite reasons, and
they get different notes. Draws count as an edge in both directions, which is
the natural reading of Ford under Davidson and stops an all-draws pairing being
called disconnected.

**The MM cross-check lives in the verification script, not in the module.** The
spec suggests implementing both MM and coordinate-wise Newton and checking they
agree. Shipping both inside `ratingBT.ts` would make the "independent"
implementation share a file, its aggregation code, and its author's assumptions
with the thing it checks — so the second implementation is written from scratch
in `verify-analysis-math.mjs` instead, from wins-and-games counts up. They agree
to **1.8e-12 Elo** and land on the same log-likelihood.

It is the *plain* Bradley-Terry MM, run on a no-draw fixture, deliberately. The
Davidson-extended MM update needs a second minorization on the √(π_iπ_j) term,
and the spec explicitly declines to derive it ("see Hunter (2004) rather than a
hand-derivation here"). Reconstructing it from memory would be inventing a
reference and calling it a check. The shared Bradley-Terry core is what gets
exercised, and a sign error in it shows up regardless of the tie term.

**Standard errors come from the full inverse information matrix.** The spec asks
only for "stderr per preset". Two presets that played each other are strongly
correlated — the likelihood only ever sees their difference — so diagonal-only
errors read too narrow. Measured on the same fixture: 12.198 Elo full-covariance
against 11.976 diagonal-only. Small, but free, and it is the kind of 2% that
quietly turns a 95% interval into a 94% one. The β/θ cross term was the easiest
piece of algebra to get wrong here, which is why it is checked against a
numerically differentiated Hessian rather than reasoned about.

**A colour-swapped pair always finishes, even after the SPRT decides.** Not
addressed by the spec, and two of its requirements pull apart: the trinomial LLR
is a per-game quantity (so the stopping rule is evaluated per game), but
cancelling first-move bias is the entire reason the runner swaps colours (so
stopping dead can leave the sample one game heavier in white). The pair
completes; the extra game goes into the log for the rating fit and the
already-decided SPRT ignores it. Costs at most one game.

**The runner keeps playing after the test decides, and that turned out to be
mandatory rather than nice.** The spec's two goals — "measure empirical strength
of every preset" and "stop once the evidence is in" — quietly conflict. A
lopsided pairing crosses the SPRT boundary in about eight games, which is the
sequential test working perfectly, and eight games of a lopsided pairing is a
whitewash. A preset that never lost has an Elo unbounded above, Ford's condition
fires, and it drops out of the fit. The first full batch decided all five of its
questions and could rate **nobody**. So `minGames` keeps the games coming for the
fit's sake while `recordGame` ignores everything past the boundary, leaving α and
β exactly as claimed. Mild caveat, stated rather than hidden: total N now depends
on outcomes, which is a small optional-stopping effect on the fit's intervals.

**Openings are dealt from a shuffled deck, not sampled with replacement.** The
spec says "picked uniformly per game" and sizes the book so repeats are rare —
reasoning about repeats-per-line at 320 games. At small N that reasoning
understates the problem badly, because a repeat is not a slightly-correlated
game, it is a *byte-identical* one against a deterministic engine: zero
information, but the SPRT counts it as evidence and the interval it reports comes
out too narrow. Measured, not predicted: Maia 1900 vs Maia 1100 logged 34 games
of which **22 were distinct**. Seventeen opening draws over a 21-line book
collide about a third of the time, which is exactly what the birthday arithmetic
says. Dealing without replacement makes it impossible for the first 42 games of
any match, and `sprt-run.mjs` drops cross-run collisions on exact move-sequence
identity — Stockfish's timing jitter does sometimes make two runs of one opening
genuinely diverge, and those are two real games.

**`scripts/refit-ratings.mjs` exists so "a cache, not a second source of truth"
is executable.** The spec says `ratings.json` is regenerable from the log at any
time. That is the kind of claim that rots quietly, so there is a script that does
it — including replaying each run's SPRT from the logged games rather than
trusting the stored terminal state, which is what caught the duplicate problem
above in the first place. It flags any run whose replayed LLR disagrees with what
was stored, instead of silently overwriting it.

**A single match holds γ fixed; only the pooled fit estimates it.** The spec
calls γ a nuisance parameter "fit once from pooled data", and that is exactly
what `sprt-run.mjs` does when it regenerates `ratings.json` across every logged
game. Inside one ~30-game pairing there is nowhere near the data — a noisy γ̂
would drag δ̂ with it — so `matchRunner.ts` pins γ at the SPRT's value, which
also honours the spec's "rating fit and SPRT share one model, not two". The
consequence is that a match's own reported gap and the pooled fit's gap for the
same pair differ slightly. That is the two γ's, not an inconsistency.

**The verification script runs the repo's actual TypeScript.** The spec's plan
for `verify-analysis-math.mjs` assumes this is possible, and it is — Node 24
strips types with no flag and no dependency — but with a catch that reads like a
different problem entirely: Node does not rewrite import specifiers, so our
extensionless relative imports fail with `ERR_MODULE_NOT_FOUND` naming a file
that is plainly there, while the `import type` lines resolve fine because they
are erased first. `scripts/ts-extension-resolver.mjs` is a ten-line resolve hook.
Written up in `docs/deployment.md` §4 so the next Node-side check doesn't
rediscover it.

**The book got a transposition check the spec doesn't ask for.** It asks for
"structurally distinct lines... not move-order permutations", which is a property
you can assert about a list and be wrong about. Replaying each line and comparing
the resulting positions is the same claim, measured: 21 lines, 21 distinct
positions. Sizing came out at 21 rather than the spec's ~16 minimum, which buys
margin on the 320-game case where 16 lines average ~20 repeats each.

**Glicko-2 was built** despite being marked "secondary, optional", because
Glickman's paper ships a fully worked example — so it is ~90 lines that arrive
with their own known-answer test, which is a better ratio than most code gets.

### Verification — observed, not asserted

`node scripts/verify-analysis-math.mjs`, ~10 seconds, no Chrome and no engine:
**55 checks, all green.** The ones that would actually have caught something:

- **Newton vs an independently written MM fit:** agree to 1.8e-12 Elo across
  three presets, identical log-likelihood.
- **Standard errors vs a numerically differentiated Hessian:** match to four
  decimal places, for both δ̂ and γ̂.
- **Interval coverage:** 96.3% of 300 replications put the truth inside
  δ̂ ± 1.96·stderr. This is the check a wrong Hessian fails and every other check
  above passes.
- **SPRT error rates:** 96.5% correct under H1 and 94.8% under H0 over 400
  series each, against a nominal 95% — the right side of nominal, as Wald's
  overshoot-ignoring bounds predict. Mean stopping counts 25.1 and 22.8 against
  a predicted 22.3 and 20.7.
- **Glicko-2 vs the paper:** 1464.0507 / 151.5165 / 0.06 against Glickman's
  published 1464.06 / 151.52 / 0.05999.
- **Colour bookkeeping:** mirroring every game (swap sides, flip result) leaves
  the fit bit-identical. Reading `1-0` as "preset A won" is right half the time
  and silently wrong the other half, and no amount of eyeballing a plausible Elo
  reveals it.
- **The half-win bias, measured rather than argued:** the spec derives
  algebraically that scoring draws as half-wins understates a true 200-Elo gap as
  ~159. On 4,000 synthetic games it came out at **158.2**.
- **The spec's own worked numbers** — P(win)=0.626 at δ=200/γ=0.5, E₁[Z]=0.119
  and 0.0082, E[N]≈22 and ≈320 — all reproduce. Worth having: they are what the
  whole "is this worth 320 games" argument rests on, and nobody had run them.

### The matches, and what they found

114 games across six pairings, in `web/lib/analysis/fixtures/`. Full write-up in
[`../rating-notes.md`](../rating-notes.md); the three findings:

- **Stockfish's `UCI_Elo` is real** — 1800 beat 1320 7-1-0, 2800 beat 1800 8-0-0,
  both crossing the H1 boundary almost immediately. Task 2's open question is
  closed.
- **Maia's tiers barely differentiate.** 1500 vs 1100 over 38 games: 16W 9D 13L,
  a fitted gap of **34 Elo** against a 400-point label gap, no decision reached.
  Same thing `docs/maia-notes.md` saw in the logits, now measured in games.
- **Stockfish's weakened presets lose to Maia badly** — Maia 1100 beat Stockfish
  1320 26-2-2. `UCI_LimitStrength` appears to weaken by injecting occasional
  catastrophic moves rather than by playing consistently weaker chess, so the
  dropdown numbers are not comparable across the two engines.

Stockfish 2800 has no rating: it won all eight of its games, and a preset that
never loses is unbounded above. Ford's condition doing its job, not a gap in the
data.

**One reported result did not survive the audit, which is the best argument for
having built the audit.** The first Maia 1900 vs Maia 1100 match reported H1 on
an LLR of 3.141 over 34 games. Replayed from the deduplicated log it is **1.795
over 22 games — no decision**. Twelve of those games were byte-identical
duplicates and the SPRT had counted them as evidence. Nothing was wrong with the
test; it was fed games that did not exist.

**Regression:** `/model-1v1` driven in headless Chrome after the `gameLoop.ts`
change — 8 plies, no console errors, PASS. The one live caller of `runModelGame`
passes no `startFen` and behaves exactly as before.

### Left undone

- **Three of the six pairings are short.** The two Stockfish ones and Maia 1500
  vs Stockfish 1800 ran 8 games each, because the sequential test decided and
  stopped before `minGames` existed. Directions are solid, magnitudes are weak.
  Re-running them at `minGames=30` is the highest-value follow-up.
- **The full 15-pairing roster is not played.** The spec puts scheduling out of
  scope ("a thin loop left unchoreographed") and the fixture covers a connected,
  anchored subgraph rather than every pair. Adding a pairing is one more
  `sprt-run.mjs` invocation; `ratings.json` refits over everything logged.
- **Every match is a 0-vs-200 question.** The spec's precision case (0 vs 50,
  ~320 games) is a ~3-hour serial run per pairing and was not started.
- **Still no parallelism.** `engineStockfish.ts` is one shared Worker behind a
  promise queue, so two concurrent games interleave onto it rather than going
  faster. `2026-08-05-engine-worker-pool.md` is the real fix and does not exist.
  The multi-tab workaround the spec suggests would work today and wasn't needed
  at this scale.
- **Pentanomial scoring**, fishtest's actual refinement, is still a deliberate
  non-goal — trinomial plus colour-pairing is the smaller step.
- **`label`-as-id.** `EngineConfig` still has no identifier, so renaming a preset
  orphans its logged history. Cheap to fix if it ever bites.

---

## After Phase 3

Stop and check in with the user. Stretch goals (eval bar, blunder summary, adaptive-opponent heuristic, win-rate stats, expanding Maia to all 9 rating tiers) are explicitly not part of this plan — they get their own planning pass only after Phases 0–3 are confirmed working end to end.
