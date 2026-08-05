# The Engine Room — Design

Chess web app: watch two engines play each other (Model 1v1), or play an
engine yourself (User 1v1). Hackathon MVP, zero budget, hosted on Vercel.
Planned today (2026-08-03), build starts tomorrow.

## Goals / constraints

- Submittable as a working demo + repo. No formal rubric to optimize for —
  "it works and looks reasonable live" is the bar.
- No user accounts/auth. Fully anonymous — KV game records aren't tied to
  any identity.
- Zero budget: Vercel free tier, free-tier storage, no paid APIs.
- chess.js owns all chess rules (legality, game-end detection). Engines only
  ever choose from `chess.moves()` — never hand-roll rules.
- Real training/fine-tuning of any model is explicitly out of scope, now and
  later. If "learning" is added post-MVP, it's a heuristic layer that reads
  game logs and adjusts engine *settings* (skill level, move selection) —
  it never touches model weights.
- Also out of scope for this submission: live LLM commentary, tournament
  mode, puzzle/training mode, opening repertoire tools.
- Visual/theme direction (train-themed, per "Engine Room") is being designed
  separately — not this doc's concern.

## Phases

Work stops after each phase for a check-in before moving to the next.
Nothing beyond what's listed here gets built without an explicit ask.

### Phase 0 — Engine integration spike (no UI)

The two riskiest pieces of this stack, proven standalone before any UI is
built around them:

- Stockfish.wasm (single-threaded build — avoids the SharedArrayBuffer /
  COOP-COEP header configuration that the multi-threaded build requires)
  running in a Web Worker. Given a FEN + `UCI_Elo`, returns a legal move.
- One Maia weight (start with the 1500-rating tier) converted to ONNX,
  running via `onnxruntime-web` in the browser. Given a FEN, returns a
  legal move.

**Done when:** both return a chess.js-legal move for a handful of test
positions. No board, no styling required — a console.log proving it is
enough. This phase exists specifically so integration risk doesn't surface
mid-way through Phase 1 with no time left to recover.

### Phase 1 — Model 1v1

- Menu screen: "Model 1v1" or "User 1v1"
- Model 1v1 screen: pick two engine configs from preset dropdowns
  - Stockfish presets via `UCI_LimitStrength=true` + `UCI_Elo`: 1320, 1800,
    2800 (real engine-reported ELO, not a faked label)
  - Maia presets: rating tiers 1100, 1500, 1900 (of the 9 available
    1100–1900 tiers; the rest are a stretch goal — see below)
- Client-side game loop alternates the two engines; chess.js validates and
  applies every move; a short delay between moves makes it watchable
  instead of instant
- ELO/rating label shown per side
- On game end (chess.js detects checkmate / stalemate / draw by repetition /
  50-move rule / insufficient material — no custom end-game logic needed),
  write the result to KV

### Phase 2 — User 1v1

- Pick one engine (Stockfish or Maia) + difficulty/tier, pick color
- `react-chessboard` for click/drag input; chess.js validates every move
- End-of-game result screen: win/loss/draw, ELO/tier faced
- Log the finished game to KV

### Phase 3 — History page

- Simple read-only page listing past games from KV: players/engines,
  result, timestamp
- No filtering, search, or pagination in the MVP

### Stretch goals (only after Phases 0–3 all fully work)

- Eval bar (Stockfish provides this natively — just surface it)
- Post-game blunder summary from eval swings
- Adaptive opponent (heuristic-only, per the constraint above)
- Simple win-rate stats per difficulty tier
- Expand Maia from 3 rating tiers to the full 1100–1900 ladder (9 tiers)

## Architecture

### Routes (Next.js App Router)

```
/app
  page.tsx                 → menu
  model-1v1/page.tsx        → config picker + board + auto-play
  user-1v1/page.tsx         → config picker + board + play
  history/page.tsx          → past games list
  actions/games.ts          → Server Actions: saveGame(), listGames()
```

No API routes for engine inference — both engines run client-side, so the
only server-touching code in the whole app is the two KV Server Actions.
This is a deliberate simplification versus the original server-side-Maia
plan: it removes the Vercel function timeout / cold-start / binary
compatibility risk entirely.

### Engine layer

```
/lib/chess
  engineStockfish.ts   → wraps the Web Worker; getMove(fen, elo) -> Promise<Move>
  engineMaia.ts        → wraps the onnxruntime-web session; getMove(fen, ratingTier) -> Promise<Move>
  gameLoop.ts          → alternates engines, feeds moves through chess.js
/workers
  stockfish.worker.ts
/public
  stockfish/            → single-threaded wasm build assets
  maia/*.onnx            → converted weight files (1100.onnx, 1500.onnx, 1900.onnx)
```

Both engine wrappers expose the same shape — `getMove(fen, config) ->
Promise<Move>` — so `gameLoop.ts` and the User 1v1 screen are agnostic to
which engine they're calling. Adding a Maia tier later is "drop in one more
`.onnx` file + one preset entry," not a code change.

### Components

- `Board` — wraps `react-chessboard`
- `EngineConfigPicker` — preset dropdown(s)
- `ResultScreen` — end-of-game summary
- `HistoryList` — Phase 3 past-games list

### KV schema

Storage: Vercel's KV offering (Upstash Redis under the hood). Note: "Vercel
KV" as a standalone branded product was folded into Vercel Marketplace
storage integrations — functionally the same, but worth double-checking the
provisioning step tomorrow isn't under a renamed flow.

- `game:{id}` → JSON:
  ```json
  {
    "id": "uuid",
    "mode": "model-1v1 | user-1v1",
    "white": { "type": "stockfish | maia | human", "label": "Stockfish 1800" },
    "black": { "type": "stockfish | maia | human", "label": "Maia 1500" },
    "moves": ["e4", "e5", "..."],
    "result": "1-0 | 0-1 | 1/2-1/2",
    "endReason": "checkmate | stalemate | draw-repetition | draw-50move | draw-insufficient",
    "timestamp": 1234567890
  }
  ```
- `games:index` → sorted set (`ZADD` by timestamp) of game ids, so the
  history page reads the latest N via `ZRANGE ... REV` + `MGET` instead of
  scanning all keys

### Error handling

Kept minimal — this is a same-day hackathon build, not production
software:

- Engine fails to load (wasm/onnx init error) → inline error on that
  screen ("Engine failed to load, refresh"), not a crash
- chess.js is always authoritative: if an engine ever returns a move
  outside `chess.moves()`, discard it and fall back to a random legal move
  rather than let the game break. Shouldn't normally trigger for either
  engine, but it's a cheap defensive layer against wasm/onnx output being
  malformed.
- KV write failure at game end → swallow it, still show the result screen.
  Losing one log record isn't worth blocking the demo over.

### Testing

No formal test suite for the MVP. Phase 0's spike doubles as the smoke test
for both engines. Each subsequent phase gets manually played through (a few
auto-play games, a few user games) before the check-in with the user.
