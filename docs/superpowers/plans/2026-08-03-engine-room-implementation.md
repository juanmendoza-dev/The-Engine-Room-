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

## Phase 0 — Engine Integration Spike

No UI in this phase. The goal is to prove the two riskiest integrations work in isolation, so integration risk can't surface halfway through Phase 1 with no time left to recover.

### Task 1: Scaffold Next.js into the existing repo

The repo already has `.git`, `AGENTS.md`, `.githooks/`, `.claude/`, `docs/`, and `README.md`. `create-next-app` doesn't run cleanly into a non-empty directory, so scaffold in a sibling temp folder and merge in by hand, rather than running it in place.

**Files:**
- Create: everything a standard `create-next-app` TypeScript/App Router/Tailwind project generates (`package.json`, `tsconfig.json`, `next.config.ts`, `app/layout.tsx`, `app/page.tsx`, `app/globals.css`, `public/`, `.eslintrc`, `.gitignore`)
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
- Create: `lib/chess/types.ts`
- Create: `lib/chess/engineStockfish.ts`
- Create: `public/stockfish/` (copied single-threaded build files)
- Create: `app/dev/stockfish-test/page.tsx` (scratch verification page, removed in Task 8)
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
mkdir -p public/stockfish
cp node_modules/stockfish/bin/stockfish-18-lite-single.js public/stockfish/
cp node_modules/stockfish/bin/stockfish-18-lite-single.wasm public/stockfish/
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
// lib/chess/types.ts
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

> **Read `lib/chess/engineStockfish.ts`, not the snippet below.** The snippet
> was the plan's first draft and four things in it needed changing — the worker
> path, the handshake, request serialization, and error/timeout handling. All
> four are listed under "What differed" at the end of this task.

```typescript
// lib/chess/engineStockfish.ts
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

The shipped page runs three positions at three different ELOs rather than one,
and reports per-position timings — one position can pass by luck, and the
timings are what prove the engine is actually searching for `movetime` rather
than returning instantly.

```tsx
// app/dev/stockfish-test/page.tsx
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

Then `npm run dev` and visit `http://localhost:3000/dev/stockfish-test`. Result:

```
LEGAL    elo 1320  start position         d2d4 (d4)    1378ms
LEGAL    elo 1800  mid-opening            d2d4 (d4)     506ms
LEGAL    elo 2800  king + pawn endgame    e3d3 (Kd3)    508ms
```

No console errors. The first call carries the 7 MB wasm fetch plus the UCI
handshake; the other two land within a few ms of `movetime 500`, which is the
signal that the engine is really searching.

Verified in headless Chrome over the DevTools Protocol rather than by eye —
`chromium-cli` and Playwright aren't installed on this machine, but Chrome is,
so a throwaway CDP script (`--headless=new --remote-debugging-port`) navigated
the page, polled `document.body.innerText` until it printed `done`, and dumped
`Runtime.exceptionThrown` / console errors. Worth reusing for later tasks;
it needs no dependencies, since Node 22+ has `fetch` and `WebSocket` built in.

If the worker fails to load, check the path in `ENGINE_URL` against what's
actually in `public/stockfish/`.

- [x] **Step 7: Commit**

```bash
git add .gitattributes lib/chess/types.ts lib/chess/engineStockfish.ts public/stockfish app/dev/stockfish-test package.json package-lock.json
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
  startup. That doesn't guarantee the `UCI_Elo` / `UCI_LimitStrength` options
  have been applied by the time the engine starts searching; `readyok` does.
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
- Create: `lib/chess/engineMaia.ts`
- Create: `scripts/maia-notes.md` (what you found/did at each checkpoint, however far you got)
- Create: `public/maia/1500.onnx` (if you get far enough to have one)

**Interfaces:**
- Produces (if successful): `getMaiaMove(fen: string, config: EngineConfig) => Promise<EngineMove>` — same signature as `getStockfishMove`.
- Produces (if fallback taken): `getMaiaMove` still exists and has that signature, but its body throws `new Error("Maia not available")`.

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
<!-- scripts/maia-notes.md -->
# Maia ONNX conversion notes

Reached checkpoint: <N>
What worked:
What didn't / where it stalled:
Commands that worked (for next time):
```

Fill in real content based on what actually happened.

- [ ] **Step: Commit whatever state you're in**

```bash
git add lib/chess/engineMaia.ts scripts/maia-notes.md public/maia
git commit -m "maia onnx spike, got to checkpoint N - notes in scripts"
```

**Fallback (decide now, not under pressure tomorrow):** If Checkpoint 7 isn't reached within the 90-minute timebox, Phase 1 ships with Stockfish-only presets — `MAIA_PRESETS` (Task 4) becomes an empty array, and the Maia dropdown options simply don't appear. Maia moves to the stretch-goal list alongside expanding to all 9 rating tiers. No other code changes are needed elsewhere — this is exactly why every later task talks to `getMoveFor`, never to Maia internals directly.

---

## Phase 1 — Model 1v1

### Task 4: Engine preset registry

**Files:**
- Create: `lib/chess/engines.ts`

**Interfaces:**
- Consumes: `EngineConfig`, `EngineMove` (Task 2), `getStockfishMove` (Task 2), `getMaiaMove` (Task 3)
- Produces: `STOCKFISH_PRESETS`, `MAIA_PRESETS`, `ALL_ENGINE_PRESETS: EngineConfig[]`; `getMoveFor(fen: string, config: EngineConfig) => Promise<EngineMove>`

- [ ] **Step 1: Write the registry**

```typescript
// lib/chess/engines.ts
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

- [ ] **Step 2: Manual verification**

In a scratch browser console on any page (or extend the Task 2 test page temporarily), import and call `getMoveFor(new Chess().fen(), STOCKFISH_PRESETS[0])`, confirm it resolves to a move. If `MAIA_PRESETS` is non-empty, do the same with `MAIA_PRESETS[0]`.

- [ ] **Step 3: Commit**

```bash
git add lib/chess/engines.ts
git commit -m "add the engine preset list and a single getMoveFor entry point"
```

---

### Task 5: Menu screen

**Design reference:** `docs/design/hero-preview.html` (open directly in a
browser) + `docs/design/hero-notes.md` for the token table, copy, and a
translation note — the preview uses a design tool's own template syntax,
not JSX, so it's a visual/interaction spec to build from, not code to copy.

**Files:**
- Modify: `app/page.tsx`

- [ ] **Step 1: Replace the default page with the menu**

```tsx
// app/page.tsx
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
git add app/page.tsx
git commit -m "add the menu screen"
```

---

### Task 6: Game loop

**Files:**
- Create: `lib/chess/gameLoop.ts`

**Interfaces:**
- Consumes: `EngineConfig` (Task 2), `getMoveFor` (Task 4)
- Produces: `GameEndInfo`, `runModelGame(white, black, onMove, moveDelayMs?) => Promise<{moves: string[]} & GameEndInfo>`

- [ ] **Step 1: Write the loop**

```typescript
// lib/chess/gameLoop.ts
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

- [ ] **Step 2: Manual verification**

Temporarily call `runModelGame(STOCKFISH_PRESETS[0], STOCKFISH_PRESETS[1], (fen) => console.log(fen))` from the Task 2 scratch page (or a new throwaway one) and confirm it logs a sequence of FENs and eventually resolves with a `result`/`endReason`/`moves` array.

- [ ] **Step 3: Commit**

```bash
git add lib/chess/gameLoop.ts
git commit -m "wire up the model-vs-model game loop"
```

---

### Task 7: Board component

One component, reused read-only in Model 1v1 (Task 8) and interactively in User 1v1 (Task 10).

**Files:**
- Create: `components/Board.tsx`
- Modify: `package.json` (add `react-chessboard`)

**Interfaces:**
- Produces: `<Board fen interactive? onPieceDrop? orientation? />`

- [ ] **Step 1: Install**

```bash
npm install react-chessboard
```

- [ ] **Step 2: Write the component**

```tsx
// components/Board.tsx
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

- [ ] **Step 3: Manual verification**

Drop `<Board fen={new Chess().fen()} />` onto any page temporarily, confirm the starting position renders.

- [ ] **Step 4: Commit**

```bash
git add components/Board.tsx package.json package-lock.json
git commit -m "add a shared board component for both game modes"
```

---

### Task 8: Model 1v1 page

**Files:**
- Create: `components/EngineConfigPicker.tsx`
- Create: `components/ResultScreen.tsx`
- Create: `app/model-1v1/page.tsx`
- Delete: `app/dev/stockfish-test/` (superseded by this page)

**Interfaces:**
- Consumes: `ALL_ENGINE_PRESETS`, `getMoveFor` indirectly via `runModelGame` (Task 4, Task 6), `Board` (Task 7), `saveGame` (Task 9 — see note below)
- Produces: `<EngineConfigPicker presets value onChange label />`, `<ResultScreen result endReason whiteLabel blackLabel onRematch? />`

Note: this task references `saveGame` from Task 9, which comes after it. Write this task's page first with the `saveGame` call included but commented out, then uncomment it as the last step of Task 9. Keeps each task's commit buildable on its own.

- [ ] **Step 1: Engine config picker**

```tsx
// components/EngineConfigPicker.tsx
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

- [ ] **Step 2: Result screen**

```tsx
// components/ResultScreen.tsx
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

- [ ] **Step 3: Model 1v1 page**

```tsx
// app/model-1v1/page.tsx
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

- [ ] **Step 4: Remove the superseded scratch page**

```bash
rm -rf app/dev
```

- [ ] **Step 5: Manual verification**

`npm run dev`, visit `/model-1v1`, pick two Stockfish presets, click Start, confirm the board updates move by move (not an instant jump) and a result screen appears when the game ends.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "build the model 1v1 screen"
```

---

### Task 9: KV storage + saveGame

**Files:**
- Create: `app/actions/games.ts`
- Modify: `app/model-1v1/page.tsx` (uncomment the `saveGame` call from Task 8)
- Modify: `package.json` (add `@vercel/kv`)

**Interfaces:**
- Produces: `GameRecord` type, `saveGame(game: Omit<GameRecord, "id" | "timestamp">) => Promise<void>`

- [ ] **Step 1: Provision KV storage**

In the Vercel dashboard, create a KV storage integration for this project and link it (this may now be under "Marketplace Database Integrations" / Upstash for Redis rather than a standalone "Vercel KV" product — same functionality, just check current naming). Then pull the generated env vars locally:

```bash
npx vercel link
npx vercel env pull .env.local
```

If `vercel link`/`env pull` isn't set up yet, manually copy `KV_REST_API_URL` and `KV_REST_API_TOKEN` from the dashboard into `.env.local`. Confirm `.env.local` is covered by `.gitignore` (the scaffolded one from Task 1 already includes `.env*.local` — verify, don't duplicate).

- [ ] **Step 2: Install the client**

```bash
npm install @vercel/kv
```

- [ ] **Step 3: Write the Server Action**

```typescript
// app/actions/games.ts
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

- [ ] **Step 4: Wire it into the Model 1v1 page**

In `app/model-1v1/page.tsx`, uncomment the `import { saveGame }` line and the `await saveGame({...})` block from Task 8.

- [ ] **Step 5: Manual verification**

`npm run dev`, play a Model 1v1 game to completion, then check the Vercel KV dashboard (or `npx vercel kv` CLI tooling, or a quick scratch script calling `kv.get`) for a new `game:<uuid>` key with the expected shape and a corresponding entry in `games:index`.

- [ ] **Step 6: Commit**

```bash
git add app/actions/games.ts app/model-1v1/page.tsx package.json package-lock.json
git commit -m "log finished games to kv"
```

---

## Phase 2 — User 1v1

### Task 10: User 1v1 page

Reuses `Board` (interactive mode), `EngineConfigPicker`, `ResultScreen`, and `saveGame` — no new shared components needed.

**Files:**
- Create: `app/user-1v1/page.tsx`

**Interfaces:**
- Consumes: `Board`, `EngineConfigPicker`, `ResultScreen` (Task 7, Task 8), `ALL_ENGINE_PRESETS`, `getMoveFor` (Task 4), `saveGame` (Task 9)

- [ ] **Step 1: Write the page**

```tsx
// app/user-1v1/page.tsx
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

- [ ] **Step 2: Manual verification**

`npm run dev`, visit `/user-1v1`, pick Stockfish 1320, play as White, drag a piece, confirm the engine replies (board updates after a short pause), play through to a game end, confirm the result screen appears and a new record shows up in KV (same check as Task 9 Step 5). Repeat once as Black to confirm the engine moves first correctly.

- [ ] **Step 3: Commit**

```bash
git add app/user-1v1
git commit -m "build the user vs engine screen"
```

---

## Phase 3 — History page

### Task 11: List past games

**Files:**
- Modify: `app/actions/games.ts` (add `listGames`)
- Create: `app/history/page.tsx`

**Interfaces:**
- Consumes: `GameRecord` (Task 9)
- Produces: `listGames(limit?: number) => Promise<GameRecord[]>`

- [ ] **Step 1: Add `listGames` to the Server Action file**

```typescript
// app/actions/games.ts (append to the existing file from Task 9)
export async function listGames(limit = 20): Promise<GameRecord[]> {
  const ids = await kv.zrange<string[]>("games:index", 0, limit - 1, { rev: true });
  if (ids.length === 0) return [];
  const records = await Promise.all(ids.map((id) => kv.get<GameRecord>(`game:${id}`)));
  return records.filter((r): r is GameRecord => r !== null);
}
```

- [ ] **Step 2: History page**

```tsx
// app/history/page.tsx
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

- [ ] **Step 3: Manual verification**

Having already played a few games in Phase 1/2, visit `/history` and confirm entries appear newest-first with correct labels, results, and timestamps.

- [ ] **Step 4: Commit**

```bash
git add app/actions/games.ts app/history
git commit -m "add the game history page"
```

---

## After Phase 3

Stop and check in with the user. Stretch goals (eval bar, blunder summary, adaptive-opponent heuristic, win-rate stats, expanding Maia to all 9 rating tiers) are explicitly not part of this plan — they get their own planning pass only after Phases 0–3 are confirmed working end to end.
