# The Engine Room

Watch two chess engines play each other, or take one on yourself. Both engines
run entirely in your browser — there is no backend doing the thinking.

**Live → [the-engine-room-gold.vercel.app](https://the-engine-room-gold.vercel.app)**

## The four screens

| Route | What it does |
| --- | --- |
| `/` | Menu. A looping replay of Morphy's Opera Game (1858) plays on the board while you pick. |
| `/model-1v1` | Pick two engines, press start, watch them fight. Move log, per-side rating labels, a thinking indicator that names which engine is searching. |
| `/user-1v1` | Pick one engine and a colour, then play it. Drag or click; illegal moves snap back. Restart mid-game if it's going badly. |
| `/history` | Finished games, newest first — who played, result, how it ended. |

## The two engines

Both are real engines, not difficulty multipliers on one search.

| | Stockfish | Maia |
| --- | --- | --- |
| What it is | Classical alpha-beta search — `stockfish-18-lite-single.wasm` in a Web Worker, driven over UCI | Maia 2 "rapid" — a neural net trained to predict what a *human* of a given rating plays, one forward pass via `onnxruntime-web` |
| Strength control | `UCI_LimitStrength` + `UCI_Elo` — presets 1320 / 1800 / 2800 (1320 is this build's actual floor; the range is 1320–3190) | Rating is a **model input**, not a separate network — presets 1100 / 1500 / 1900 feed `elo_self` / `elo_oppo` as bucket indices |
| Time per move | ~500 ms (`go movetime 500`) | ~35 ms once loaded |
| Cost | 7 MB, served from `web/public/` | 93 MB, fetched at runtime from a pinned commit in our own mirror repo |

The difference is visible in play, which is the point: Stockfish 1320 plays like
a weakened engine, Maia 1100 plays like a 1100-rated person — including the kinds
of mistakes a person actually makes.

## How it works

```
      /model-1v1                    /user-1v1
          │                             │
          │  runModelGame()             │  onPieceDrop / engineReply
          └──────────────┬──────────────┘
                         │
                getMoveFor(fen, config)      ← the only engine entry point
                         │
            ┌────────────┴────────────┐
            ▼                         ▼
     engineStockfish.ts         engineMaia.ts
     Web Worker · UCI           onnxruntime-web
     postMessage handshake      [1,18,8,8] float32 in, policy
     go movetime 500            logits out, decoded to a move
            │                   and filtered to legal
            └────────────┬────────────┘
                         ▼
                     chess.js          ← sole authority on legality and game end
                         │
                         ▼
                  web/lib/games/store.ts   ← localStorage today, Vercel KV behind a flag
```

Four decisions carry most of the design:

**Engines run client-side.** No API routes for inference, so no serverless
timeout, no cold start, no wasm-in-a-lambda compatibility problem. The only
server code in the app is two Server Actions for storage.

**One contract, two engines.** Everything downstream calls
`getMoveFor(fen, config)` and never imports an engine module directly. Adding or
dropping an engine is a change to `web/lib/chess/engines.ts` and nothing else — which
is what let Maia land *after* the Model 1v1 screen was already working.

**chess.js is the only thing that knows the rules.** Engines choose from legal
moves; chess.js validates and detects every ending (checkmate, stalemate,
threefold, fifty-move, insufficient material). If an engine ever returns
something illegal it's discarded for a random legal move rather than breaking the
game. No chess logic is hand-rolled anywhere.

**Storage is behind an adapter.** `web/lib/games/store.ts` writes to localStorage by
default and to Vercel KV when `NEXT_PUBLIC_KV_ENABLED=1`. The app is fully
demo-able with nothing provisioned, and turning KV on is an env var plus a
redeploy — no code change. Runbook in [`docs/deployment.md`](docs/deployment.md) §3.

### The rest of it

- **Fight FX** — 19 effects (impact, shake, ghosts, combo counters, a charge bar
  fed by Stockfish's real search depth) over a tier ladder that classifies each
  move and picks a beat. Opts out entirely under `prefers-reduced-motion`, or
  `?fx=off`. [Notes](docs/design/fight-fx-notes.md).
- **Design: "Ink & Bone"** — kinetic editorial monochrome, one red accent, no
  border-radius anywhere. Day is ink on paper; night is the same print shop after
  hours, where the red stops being printed ink and becomes lit signage.
  [Notes](docs/design/ink-and-bone-notes.md).
- **Live header scoreboard** — reads whichever board is currently running through
  a module-level store and `useSyncExternalStore`, so the hero replay, both game
  screens, and any future board all feed the same readout.
- **Route transitions** — every navigation runs a printing press taking an
  impression: ink strikes where you clicked, a platen drops in slats, the
  destination's plate name types up, the platen lifts the other way.

## Repo map

```
docs/                     see docs/README.md
web/                      the Next.js app — everything below is relative to here
  app/                      routes (App Router)
    actions/games.ts          the two KV Server Actions — the only server-side code
    dev/                      verification harnesses, not part of the app (see its README)
  components/               Board, EngineConfigPicker, ResultScreen, header, brand mark…
    fx/                       the fight-FX stage and its stylesheet
  lib/
    chess/                    engineStockfish · engineMaia · engines (getMoveFor) · gameLoop
    fx/                       effect definitions, move classification, runtime
    games/                    storage: types · localStore · store (the adapter facade)
    boardFeed.ts              module store the header scoreboard subscribes to
  public/
    stockfish/                7 MB single-threaded wasm build
    ort/                      26.9 MB onnxruntime-web jsep pair — exactly the two files ORT fetches
  scripts/                  CDP verification harnesses, icon generation
```

The app lives in `web/` rather than at the repo root so the root stays readable —
`next.config.ts`, `tsconfig.json`, `postcss.config.mjs` and both `package*.json`
can't be moved individually (Next and npm resolve them from wherever the build
runs, and Next writes to two of them), so the whole project moves instead. Vercel
is configured with **Root Directory = `web`** to match.

## Run it locally

Everything runs from `web/`, not the repo root:

```sh
cd web
npm install
npm run dev          # http://localhost:3000
```

For anything you plan to trust, use the production build instead — it's what
Vercel runs, and it catches TypeScript and lint errors the dev server won't:

```sh
npm run build
npm run start
```

Two things that will otherwise waste your afternoon, both documented at length in
[`docs/deployment.md`](docs/deployment.md) §4:

- **Use `localhost`, not `127.0.0.1`, against `next dev`.** Next 16 treats
  `127.0.0.1` as cross-origin and blocks its own `/_next` dev resources, so the
  page server-renders perfectly and then never hydrates. Every click is a no-op
  and the browser console stays completely clean.
- **Rebuild after adding anything to `web/public/`.** Next 16 snapshots that folder at
  build time, so files copied in afterwards 404 until you build again.

## Docs

[`docs/README.md`](docs/README.md) is the index. The short version:

- [Deployment, and the traps](docs/deployment.md) — branch workflow, Vercel, the
  KV switch-on runbook, and a long list of things that bite in production
- [Maia integration](docs/maia-notes.md) — plane layout, policy decode, why Maia 2
  and not Maia 3
- [Design notes](docs/design/ink-and-bone-notes.md) — tokens, fonts, mechanics, traps
- [Build process](docs/) — the specs, the plan, the lane declarations, the
  code reviews. Written before the work, not tidied up afterwards.
- [`AGENTS.md`](AGENTS.md) — rules for AI agents committing to this repo, some of
  them hook-enforced

## Known limits

Stated plainly, because they're all deliberate calls rather than oversights:

- **Maia's first move is slow, and much slower on production than locally.**
  93 MB of weights plus 27 MB of ONNX runtime, and browsers won't disk-cache a
  body that size, so a page reload pays it again. Measured cold on the live site:
  73 s and 261 s. The progress readout counts bytes so you can tell it apart from
  a hang. An IndexedDB cache is the fix and isn't built yet.
- **Game history is per-browser** until someone provisions a KV store — you see
  your own games, and the page says so ("Local ledger") rather than pretending to
  be a shared archive.
- **The `UCI_Elo` presets are unproven as *strength* settings.** The spike proved
  Stockfish accepts the options and searches; it never proved 1320 plays worse
  than 2800 over a sample of games. Search depth is identical at both, because
  Stockfish weakens play by picking a worse candidate move rather than searching
  shallower. [A spec exists](docs/specs/2026-08-05-sprt-engine-ratings.md)
  to settle it with SPRT; it hasn't been run.
- **No automated test suite.** Verification is headless-Chrome CDP harnesses in
  `web/scripts/` driving the production build and asserting on the post-hydration DOM
  — full games played through the UI, drags dispatched as real pointer events,
  animation timelines sampled with `requestAnimationFrame`. Deliberate for a build
  this size, but not a substitute for unit tests.
- **Promotion is always to a queen.** No under-promotion picker.

Built for a hackathon, in a day, with several agents working in parallel — which
is what `AGENTS.md` and the work-order docs are for.
