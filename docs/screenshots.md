# Screenshots — the README gallery harness

The gallery in the root README is shot from the real app, not assembled by hand.
One command, from `web/`:

```sh
npm run shots                          # all nine
npm run shots -- --grep @maia          # only the three that need the model
npm run shots -- --grep-invert @maia   # the fast six
```

Config: `web/playwright.config.ts`. Shots: `web/e2e/gallery.spec.ts`. Output:
`docs/assets/gallery-*.png`, committed — the PNGs are the deliverable, the run
artifacts (`test-results/`, `playwright-report/`) are gitignored.

**This is not a test suite.** Verification in this repo is still the CDP scripts
in `web/scripts/`. The assertions in the spec exist so a shot fails loudly
instead of quietly photographing a loading spinner. Nothing there asserts
anything about how the app behaves.

Playwright's browser is a ~115 MB download outside the repo
(`npx playwright install chromium`), needed once per machine.

## Cost

Six of the nine shots take seconds. The three tagged `@maia` — the rating
readout, the odds panel, and the phone shot of both — each pay Maia's ~93 MB
cold load in their own browser context, and the odds shot then plays 30 games
out at ~25 ms a position. Budget several minutes and don't read a slow run as a
hung one; it's the same download the live site pays, `deployment.md` §4.

That's also why `workers: 1`. Parallel shots mean parallel 93 MB downloads
fighting for the same bandwidth, and the model is a module-level singleton per
tab, so nothing is shared between contexts.

## Traps met while building it

- **Port 3200, and `next build` runs inside the webServer command.** Several
  agents work this repo at once. A run that attaches to whatever is already on
  :3000 photographs somebody else's build — the same class of mistake as the
  two-Chromes-on-9222 note in `deployment.md` §4. `reuseExistingServer` is on,
  which also means it skips the rebuild: after touching app code, stop the old
  server or you'll shoot the previous build.
- **Kill a run and its server can outlive it.** Stopping a run mid-flight left
  `next start` orphaned on 3200; the next run happily attached to it
  (`reuseExistingServer`), skipped its own build, and then died halfway through
  with `ERR_CONNECTION_REFUSED` when the orphan got reaped. Same shape as the
  `next dev` orphan note in `deployment.md` §4. After cancelling a run, check
  `netstat -ano | grep :3200` is empty before starting another.
- **A relabelled button is not evidence the result is in frame.** The odds shot
  waited for "Play it out 30×" to become "Play it out again" — which happens the
  moment the run ends, on a button that sits *above* the numbers. It passed while
  photographing an empty "Odds from here" heading with the win/draw/loss rows cut
  off below the fold. It now asserts on the summary line underneath them and
  scrolls that into view. Worth generalising: assert on the thing you're
  photographing, not on a proxy for it.
- **`use: { reducedMotion: "reduce" }` is a type error.** It's a
  `BrowserContext` option and @playwright/test 1.62 doesn't surface it in
  `UseOptions`, so it goes in `contextOptions`. You find out from `next build`,
  not from Playwright — `playwright.config.ts` sits inside the app's `tsconfig`
  include and Playwright itself never type-checks anything. Anything under
  `web/e2e/` is type-checked by the production build for the same reason.
- **Reduced motion is what makes stills possible.** The app opts out of all 19
  fight effects and the route transition under it, so no ink splatter halfway
  across the board and no press platen caught mid-drop. `?fx=off` on the game
  screens is belt-and-braces.
- **`getByLabel("White")` resolves to two elements.** The header scoreboard is a
  `role="img"` whose aria-label reads *"Move 12, white to move."*, and label
  matching is a case-insensitive substring, so every `selectOption` dies on a
  strict-mode violation. The spec's `picker()` helper scopes to `<label>`
  elements instead. EngineConfigPicker's caption is a `<span>` inside the label
  that wraps its `<select>`, so the label's own accessible name is
  "WhiteChoose an engine…" — don't match on that either.
- **The hero board has no `data-square` attributes.** `ReplayBoard` is a
  hand-built 64-div grid, not the `react-chessboard` the game screens use. Wait
  on `[aria-label*="replaying the Opera Game"]`.
- **The header scoreboard is `max-sm:hidden`.** It's the only element carrying a
  live ply count on the menu, so on a phone viewport there's nothing to wait for
  and a plain wait is the honest option.
- **Any player move on `/user-1v1` starts the 93 MB fetch.** The rating
  estimator scores your own moves, so it loads Maia even when the opponent is
  Stockfish. Stop before it lands and the shot contains "Loading the move
  model…" — which is why the phone shot waits for the readout rather than
  settling for two plies on the board.
- **Measure both ends of a drag with nothing scrolling in between.** Playwright
  makes this easier than raw CDP but not automatic: `boundingBox()` twice with a
  `scrollIntoViewIfNeeded()` between them gives you coordinates from two
  different scroll offsets and the press lands on an empty square. Long version,
  and the afternoon it cost, in `deployment.md` §4.
- **No `isMobile: true` on the phone project.** Mobile emulation changes how
  pointer input is synthesized and one phone shot has to complete a board drag.
  The 390px viewport is all that shot actually needs.
- **The history shots seed `localStorage` directly** via `addInitScript`, rather
  than playing four games through the UI to photograph a list. Records are
  `GameRecord` from `web/lib/games/types.ts`, key `er:games`. Engine labels in
  the seed have to be ones `lib/chess/engines.ts` really ships — a screenshot is
  a claim about the app, and the first draft invented "Stockfish × Maia" for what
  the app actually calls "Policy Mixture (uncalibrated)".
- **A book opening is the worst thing to play for the rating shot.** The readout's
  gate is six *effective* plies, weighted by how much each position discriminates
  between rating buckets — and `1.e4 Nf3 Bc4` is what every bucket plays, so it
  discriminates almost nothing. Ten scripted book moves scored 4.2 effective
  plies; eighteen scored 5.4; the gate never opened. The CDP harness's aimless
  wing pawns open it by move 8 for the inverse reason. The spec now plays a
  readable opening first and then keeps cycling a pool of odder moves until the
  readout itself says it's ready, which is the only thing that actually knows.
