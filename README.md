<div align="center">

<img src="docs/assets/hero.svg" alt="The Engine Room" width="100%">

**The Engine Room puts two real chess engines in your browser and lets you watch them fight, or step onto the board yourself.**

![engines](https://img.shields.io/badge/engines-2%20real%20ones-e0331f?style=flat-square)
![stockfish](https://img.shields.io/badge/stockfish-18%20lite%20wasm-16151a?style=flat-square)
![maia](https://img.shields.io/badge/maia-2%20rapid%20onnx-16151a?style=flat-square)
![backend](https://img.shields.io/badge/backend-your%20own%20cpu-555?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-555?style=flat-square)

[Live demo](https://the-engine-room-gold.vercel.app) · [How Maia works](docs/maia-notes.md) · [Design notes](docs/design/ink-and-bone-notes.md) · [Build plan](docs/plans/2026-08-03-engine-room-implementation.md) · [Devlog](docs/devlog/)

</div>

---

Most chess apps that let you "play the computer" are one engine with a difficulty slider. This one ships two actually diffrent minds to ur browser: Stockfish plays the best move it can find, Maia plays the move a *person* at your rating would actually play, mistakes included. So basically chess, but honesty at the forefront of the whole design. Watch them fight each other, play one yourself, and while you play it quietly tells you what rating you play like. No backend doing any of the thinking btw, its all your CPU.

> [!NOTE]
> Maia is a 93 MB neural net so your first game can take a min or two to load, sorry about that :( theres a progress bar so you know its loading and not just hanging. every game after that in the same tab is instant

## the beautiful gallery

<table>
<tr>
<td width="50%" valign="top">
  <img src="docs/assets/gallery-hero.png" width="100%" alt="the menu with the Opera Game replaying">
  <p align="center"><sub>the front door. Morphys Opera Game (1858) replays itself on a loop while you decide</sub></p>
</td>
<td width="50%" valign="top">
  <img src="docs/assets/gallery-model-1v1.png" width="100%" alt="two engines mid-game">
  <p align="center"><sub>two engines mid fight. move log, rating labels, and a lamp naming whos thinking</sub></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
  <img src="docs/assets/gallery-rating.png" width="100%" alt="the live rating readout">
  <p align="center"><sub>it reads ur own moves and tells you what you play like. as a band not a number, cause honesty</sub></p>
</td>
<td width="50%" valign="top">
  <img src="docs/assets/gallery-odds.png" width="100%" alt="the odds readout after 30 rollouts">
  <p align="center"><sub>ask for the odds and it plays ur exact position out 30 times, then counts how those games ended</sub></p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
  <img src="docs/assets/gallery-history.png" width="100%" alt="the history page">
  <p align="center"><sub>every finished game, newest first</sub></p>
</td>
<td width="50%" valign="top">
  <img src="docs/assets/gallery-night.png" width="100%" alt="the night edition">
  <p align="center"><sub>the night edition. the red stops being printed ink and becomes lit signage, my favorite detail ngl</sub></p>
</td>
</tr>
</table>

and it all works on ur phone too:

<table>
<tr>
<td width="33%" valign="top">
  <img src="docs/assets/gallery-mobile-hero.png" width="100%" alt="the menu on a phone">
  <p align="center"><sub>the front door, phone sized</sub></p>
</td>
<td width="33%" valign="top">
  <img src="docs/assets/gallery-mobile-user.png" width="100%" alt="playing an engine on a phone">
  <p align="center"><sub>playing an engine, rating readout and all</sub></p>
</td>
<td width="33%" valign="top">
  <img src="docs/assets/gallery-mobile-history.png" width="100%" alt="the history page on a phone">
  <p align="center"><sub>the ledger fits too</sub></p>
</td>
</tr>
</table>

## See it work!!!!

<!-- drop the demo video in here when its ready:
<a href="https://youtu.be/VIDEO_ID">
  <img src="https://img.youtube.com/vi/VIDEO_ID/maxresdefault.jpg" width="100%" alt="Watch the demo">
</a>
-->

Just open the [live demo](https://the-engine-room-gold.vercel.app) yourself. Hit **Model 1v1** and put Stockfish 2800 against Maia 1100, its an engine that only knows the best move versus a net that only knows what a beginner would do, and its exactly as one sided as it sounds. Or go to **User 1v1** and play Maia at your own level (great if you have no friends, it never says no), and by around move 8 the readout under the board starts telling you what rating your moves look like. live. while ur playing.

## What Stockfish says vs what actually happens

Stockfishs eval answers *"whats the best score here"*. The odds button answers a completly diffrent question: *"how does this actually tend to end for players at this rating"*. same positions, both engines asked:

| Stockfish says | Maias 30 playouts say |
|---|---|
| **+6.44**, totally winning | won **73%** of the time. the other 27%, the human level players let it slip |
| **+0.23**, dead equal | mostly **draws**, as youd hope |
| **−6.28**, totally lost | lost **90%** of the time, so at least the bad news is reliable |

Thats kinda the whole point of having both engines in one app: winning and won by people like you are genuinely diffrent facts, and now you can actually watch the gap between them. every number comes with its confidence interval and sample size on screen, and moving a piece wipes the panel, cause those numbers were for that one exact position and leaving them up wouldve been lying.

---

## How the chess works

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

### 1. Two real engines, not one engine with a slider

| | Stockfish | Maia |
| --- | --- | --- |
| What it is | Classical alpha-beta search, `stockfish-18-lite-single.wasm` in a Web Worker, driven over UCI | Maia 2 "rapid", a neural net trained to predict what a *human* of a given rating plays, one forward pass via `onnxruntime-web` |
| Strength control | `UCI_LimitStrength` + `UCI_Elo`, presets 1320 / 1800 / 2800 (1320 is this builds actual floor) | Rating is a **model input**, not a seperate network, presets 1100 / 1500 / 1900 feed `elo_self` / `elo_oppo` as bucket indices |
| Time per move | ~500 ms | ~35 ms once loaded |
| Cost | 7 MB, served from `web/public/` | 93 MB, fetched at runtime from a pinned commit in our own mirror repo |

you can actually see the difference in play, thats the whole point: Stockfish 1320 plays like a weakened engine, Maia 1100 plays like an actual 1100 rated person, kinds of mistakes and all.

<details>
<summary>How a chess position becomes a tensor</summary>

Maia 2 takes an 18 plane `8×8` board encoding: 12 planes of piece placement (6 piece types × 2 colors), plus castling rights and en passant, more game state than Maia 3 encodes (one reason we use 2, the other is licensing, Maia 2 is MIT, Maia 3s weights are AGPL). the board gets mirrored for black to move. the policy head outputs logits over 1880 possible moves, we mask to whatever chess.js says is legal and take the best one (or sample, for rollouts). full plane layout and the decode are in [`docs/maia-notes.md`](docs/maia-notes.md).

</details>

### 2. One contract, two and a half engines

Everything downstream calls `getMoveFor(fen, config)` and never imports an engine module directly. adding or dropping an engine is a change to one file, thats what let Maia land *after* the Model 1v1 screen already worked, and later let a third opponent slot in with zero UI changes: the **Policy Mixture** preset, where Stockfishs MultiPV search picks a shortlist of decent moves and Maia picks the one a human would play from it. labelled *(uncalibrated)* in the picker cause its real strength hasnt actually been measured yet, we dont label things stronger than we can prove, see the limits below.

### 3. chess.js is the only thing that knows the rules

Engines choose from legal moves. chess.js validates every single one and detects every ending (checkmate, stalemate, threefold, fifty move, insufficient material). if an engine ever returns something illegal its discarded for a random legal move instead of breaking the game. **zero hand rolled chess rules.** i compose a battle tested rules library, i dont invent my own, rule number one of this whole project. (yea its the same rule as the crypto one from my last project, some things you just dont hand roll)

### 4. Storage is behind an adapter

`web/lib/games/store.ts` writes to localStorage by default and to Vercel KV once `NEXT_PUBLIC_KV_ENABLED=1` is flipped. the app is fully demoable with nothing provisioned, and turning KV on is just an env var plus a redeploy, no code change. the history page says which mode its actually in ("Local ledger" vs "Shared archive") instead of pretending a per browser list is global, cause that wouldve lied to a judge opening the demo fresh.

---

## The analysis layer (honest numbers were always at the forefront of the design)

<table>
<tr>
<td width="33%" valign="top">
  <b>Live rating estimate</b>
  <p><sub>Every move you make gets scored against all nine of Maias rating buckets, and bayes rule turns that into a guess at "which rating plays like this". shows nothing until it has enough evidence to be worth reading (about 6 effective plies), and it never names a number without its interval.</sub></p>
</td>
<td width="33%" valign="top">
  <b>Odds from here</b>
  <p><sub>Flat Monte Carlo, not MCTS. 30 playouts with Maia moving for both sides, batched through one ONNX session. truncated games get sampled from the value head so the counts stay honest integers and the intervals keep meaning what they say.</sub></p>
</td>
<td width="33%" valign="top">
  <b>Fight FX</b>
  <p><sub>19 effects, impact frames, screen shake, ghosts, combo counters, a charge bar fed by Stockfishs real search depth, over a tier ladder that classifies each move. fully opts out under <code>prefers-reduced-motion</code> or <code>?fx=off</code>.</sub></p>
</td>
</tr>
</table>

the chrome is one system too: an "Ink & Bone" print shop design (kinetic editorial monochrome, one red accent, no border radius anywhere), a header scoreboard that reads whichever board is actually running, and every navigation is a printing press taking an impression, the ink literally strikes the pixel you clicked. day is ink on paper, night is the same print shop after hours. (this is the part i keep opening just to look at) [Notes](docs/design/ink-and-bone-notes.md).

---

## the no bueno

Two shipped features actually *read Maias probabilities as real probabilities*, the rating estimate uses them as likelihoods, the rollouts sample from them. so before submitting i audited whether the numbers deserve that trust: when Maia puts 30% on a move, do humans in that bucket really play it ~30% of the time? nobody publishes that number (CSSLab publish accuracy, not calibration), so i measured it myself, 3,015 positions from real rated games, offline in Node.

The finding is a trap worth sharing: **the obvious calibration metric comes out 13x better than the honest one.** pooled over every (position, legal move) pair the error is 0.0028, looks perfect. but ~90% of those pairs are moves carrying under 1% probability, where being "calibrated" is trivial. restrict to the models own top move per position and the error is **0.036, all overconfidence**, fitted temperature 1.129. everytime Maia says its 84% sure, its actually right about 73% of the time.

So the verdict on my own features: broadly trustworthy, mildly oversharp about its favourite move, and the wide credible intervals the rating readout draws were the right call all along. the same measure before believing habit caught something worse earlier: the rating estimators spec guessed two of its constants a whole order of magnitude off in units, shipping them as written would've made the posterior ignore its own evidence, found by actually measuring the info content per move instead of just reading the spec twice.

<sub>The audit: [`docs/maia-calibration-notes.md`](docs/maia-calibration-notes.md) (PR #28). the constants story is in Task 13s "What differed from the spec" in [the plan](docs/plans/2026-08-03-engine-room-implementation.md).</sub>

---

## What this does *not* tell you

Numbers are only worth anything next to their limits, so here is mines plainly 😓😓😓

<table>
<tr>
<td valign="top" width="60" align="center">
  <img src="docs/assets/icon-caution.svg" width="40" alt="">
</td>
<td valign="top">
  <b>Maias first load is slow, and slower on production</b><br>
  <sub>93 MB of weights plus 27 MB of ONNX runtime, and browsers wont disk cache a body that size so a page reload pays it again. measured cold on the live site: 73s and 261s. the progress readout counts bytes so you can tell it apart from a hang. an IndexedDB cache is the real fix and isnt built yet.</sub>
</td>
</tr>
</table>

<table>
<tr>
<td valign="top" width="60" align="center">
  <img src="docs/assets/icon-caution.svg" width="40" alt="">
</td>
<td valign="top">
  <b>The rating estimate resolves to about ±1 bucket, not 100 points</b><br>
  <sub>Neighbouring Maia buckets differ by 1-3 percentage points on a given move, so a games worth of your play locates you within a couple hundred points and no better, fed Maias own 1700 rated moves, the posterior peaks at 1600 on one game and 1800 on another. thats why its drawn as a band. it also measures which buckets move <i>distribution</i> you resemble, which correlates with rating without being the same thing.</sub>
</td>
</tr>
</table>

<table>
<tr>
<td valign="top" width="60" align="center">
  <img src="docs/assets/icon-caution.svg" width="40" alt="">
</td>
<td valign="top">
  <b>The dropdown numbers are not one shared scale across the two engines</b><br>
  <sub>We ran actual SPRT matches to check (114 games, Bradley-Terry fit, <a href="docs/rating-notes.md">write-up</a>). Stockfishs <code>UCI_Elo</code> is real, 1800 beat 1320 7-1-0, 2800 beat 1800 8-0-0. but Maias tiers barely differentiate (1500 measured just 34 Elo above 1100, against a 400 point label gap), and Maia 1100 beat Stockfish 1320 <b>26-2-2</b>, weakened Stockfish seems to inject occasional catastrophic moves rather than play consistently weaker chess. so read the labels as within engine settings, not a shared ladder.</sub>
</td>
</tr>
</table>

<table>
<tr>
<td valign="top" width="60" align="center">
  <img src="docs/assets/icon-caution.svg" width="40" alt="">
</td>
<td valign="top">
  <b>The rollouts model Maia playing Maia, not humans playing humans</b><br>
  <sub>Maia imitates moves from human vs human games, chaining its own samples back into itself for dozens of plies is an input distribution nobody has validated against real games. treat the odds as informative, not precise, the intervals are wide on purpose. also promotion is always to a queen, sorry underpromotion fans.</sub>
</td>
</tr>
</table>

If you find something I've missed or misstated please reach out to me! this whole project turned into a series of "measure it instead of assuming it" moments and id genuinely love more of them.

---

## How its verified

No unit test suite, deliberately, for a build this size, but nothing here got verified by eye either. verification is **headless-Chrome CDP harnesses** in `web/scripts/` that drive the *production build* and assert on the post hydration DOM: full games played through the UI with real dispatched pointer drags, illegal moves confirmed rejected, end of game records cross checked against an independent chess.js replay of the move log, animation timelines sampled with `requestAnimationFrame` instead of wall clock guesses. the big features then re ran the same harnesses **against the live production site** after merging too, cause a green Vercel build says nothing about UI that only renders client side.

The maths got the same treatment: Wilson intervals checked against hand computed cases, the batch evaluator against single evaluations (bit identical, 0.000e+0), the sampler against its target distribution over 6,000 draws, and a mate in 1 comes back 30/30 wins. the gallery above is shot by a Playwright spec (`web/e2e/`), thats a camera, not a test suite, and [`docs/screenshots.md`](docs/screenshots.md) says so.

```bash
cd web && npm run build && npm run start   # the harnesses drive the production build
node scripts/cdp-verify.mjs               # then point one at it
```

## Three days, 30 PRs (and counting!!!!!!)

| Phase | What shipped |
|---|---|
| Planning | The design doc, an 11 task build plan, and parallel agent lane declarations, all before any code |
| 0 | The two engine spikes: Stockfish over UCI in a worker, Maia 2 via ONNX (the risky one, timeboxed) |
| 1 | Menu, engine registry, game loop, Model 1v1, the first watchable fight |
| 2-3 | User 1v1 with drag input, history page, storage adapter |
| Redesign | Ink & Bone: the whole visual system, header scoreboard, brand mark, the printing press route transition, Fight FX |
| Day three | The analysis layer: live rating inference, Monte Carlo odds, the policy mixture opponent, the calibration audit, and SPRT matches measuring what the presets are actually worth |

<sub>Planned on the 3rd, built on the 4th and 5th. every change landed as a squash merged PR off `main`, every commit signed and verified.</sub>

## How I worked

I used Claude Code as an implementation partner and basically as a SWE the whole way through, several agents in parallel actually, and this repo keeps the paper trail instead of hiding it (its right there in the tree, `.claude/` and everything). [`AGENTS.md`](AGENTS.md) is the rulebook: signed commits, no AI co-author trailers, human sounding messages, and the interesting part is its **hook-enforced** not honor system, `.githooks/` rejects unsigned pushes and AI attribution trailers mechanically. agents claimed lanes in writing ([`docs/devlog/`](docs/devlog/)) so nobody landed on the same files, specs got written *before* the work, and every task in [the plan](docs/plans/2026-08-03-engine-room-implementation.md) carries a "What differed from the plan" section recording where reality disagreed with the spec, which it did, measurably, almost everytime. the architecture decisions, the priority order and every scope call were mine. same philosophy as my last project: i write everything down as i go so other people (and other agents) can pick the work up without worrying about breaking something they cant see.

## Run it yourself (if the vercel doesnt work for some reason)

Everything runs from `web/`, not the repo root:

```bash
cd web
npm install
npm run dev          # http://localhost:3000
```

For anything you plan to trust, use the production build, its what Vercel runs and it catches what the dev server wont:

```bash
npm run build
npm run start
```

Two things that will otherwise eat your afternoon (both documented at length in [`docs/deployment.md`](docs/deployment.md) §4): use **`localhost`, not `127.0.0.1`**, against `next dev`, Next 16 treats `127.0.0.1` as cross origin and serves you a page that renders perfectly and never hydrates, every click a no-op, console totally clean. and **rebuild after adding anything to `web/public/`**, Next snapshots that folder at build time.

<details>
<summary>Deploying your own</summary>

One Vercel project: import the repo, set **Root Directory to `web`** (the app doesnt live at the repo root, Next and npm resolve their configs from wherever the build runs, so the whole project moved down a level), leave everything else default. `main` is production, every PR gets a preview URL.

Game history runs on localStorage out of the box. to make it a shared archive, connect an Upstash Redis store, set `NEXT_PUBLIC_KV_ENABLED=1`, and redeploy, the full runbook is [`docs/deployment.md`](docs/deployment.md) §3.

</details>

<details>
<summary>Repo map</summary>

```
docs/                     see docs/README.md, reference vs process, split on purpose
web/                      the Next.js app, everything below is relative to here
  app/                      routes (App Router)
    actions/games.ts          the two KV Server Actions, the only server-side code
    dev/                      verification harnesses, not part of the app
  components/               Board, EngineConfigPicker, ResultScreen, header, brand mark…
    fx/                       the fight-FX stage and its stylesheet
  lib/
    analysis/                 rating inference: maiaLikelihood · ratingPosterior
    chess/                    engineStockfish · engineMaia · engines (getMoveFor) · gameLoop · maiaRollout
    fx/                       effect definitions, move classification, runtime
    games/                    storage: types · localStore · store (the adapter facade)
  public/
    stockfish/                7 MB single-threaded wasm build
    ort/                      26.9 MB onnxruntime-web jsep pair, exactly the two files ORT fetches
  scripts/                  CDP verification harnesses, icon generation
  e2e/                      the Playwright gallery camera
```

</details>

## Where the reasoning lives

This repo keeps its reasoning, not just its code, [docs/](docs/) has the full index. i wrote everything down as i went so you dont have to trust me, you can just check. the docs split into *reference* (kept current) and *process* (deliberately not rewritten after the fact, so it records what was believed at the time, several docs are wrong in interesting ways and say so).

| Path | Whats in it |
|---|---|
| [`docs/maia-notes.md`](docs/maia-notes.md) | The Maia integration end to end: why Maia 2 over 1 and 3, the tensor layout, the policy decode, the measurements |
| [`docs/maia-calibration-notes.md`](docs/maia-calibration-notes.md) | The audit: are Maias probabilities actually probabilities (mostly, mildly overconfident) |
| [`docs/rating-notes.md`](docs/rating-notes.md) | The SPRT matches: Stockfishs presets are real, Maias tiers barely differ, and the two scales dont compare |
| [`docs/deployment.md`](docs/deployment.md) | Branch workflow, Vercel, the KV runbook, and a long §4 of production traps that each cost someone an afternoon |
| [`docs/specs/`](docs/specs/) | Design specs per feature, written before the work |
| [`docs/plans/`](docs/plans/) | The build plan, with per task "What differed from the plan" post-mortems |
| [`docs/reviews/`](docs/reviews/) | Independent review briefs, the Maia one reproduces the browser encoder against CSSLabs own training pipeline in Python |
| [`docs/devlog/`](docs/devlog/) | Lane declarations and the agent kickoff prompt, how the parallel work didnt collide |

## Stack

| | |
|---|---|
| App | Next.js 16 (App Router) + TypeScript + Tailwind 4, deployed on Vercel |
| Engines | `stockfish` 18 lite-single wasm in a Web Worker · Maia 2 rapid via `onnxruntime-web` |
| Rules | chess.js, the sole authority, **zero hand rolled chess logic** |
| Board | react-chessboard v5 |
| Storage | localStorage today, Vercel KV behind one env flag, no accounts ever |

<sub>love from miamiiiiii 💙</sub>

<sub>MIT licensed.</sub>
