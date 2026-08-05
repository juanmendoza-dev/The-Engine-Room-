/**
 * The README gallery, shot from the real app.
 *
 * Each test writes one `docs/assets/gallery-*.png`. They're tests only because
 * @playwright/test gives us fixtures, timeouts and retries for free — the
 * assertions exist to make a shot fail loudly rather than quietly photograph a
 * loading spinner. Nothing here verifies app behaviour; that's still the CDP
 * harnesses in `web/scripts/`.
 *
 *   npm run shots                       # all nine
 *   npm run shots -- --grep @maia       # just the three that need the model
 *   npm run shots -- --grep-invert @maia
 *
 * Each @maia shot pays a ~93 MB model download in its own browser context, and
 * the odds one then plays 30 games out. Budget several minutes for those three
 * and expect the other six to be seconds.
 */

import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const ASSETS = path.resolve(__dirname, "..", "..", "docs", "assets");

async function shoot(page: Page, name: string) {
  fs.mkdirSync(ASSETS, { recursive: true });
  await page.screenshot({
    path: path.join(ASSETS, `${name}.png`),
    animations: "disabled",
  });
}

/**
 * The `<select>` under a given caption.
 *
 * Not `getByLabel("White")`: the header scoreboard is a `role="img"` whose
 * aria-label reads "Move 12, white to move." and label matching is a
 * case-insensitive substring, so that resolves to two elements and every
 * selectOption dies on a strict-mode violation. Scoping to `<label>` elements
 * sidesteps it — and EngineConfigPicker's caption lives in a `<span>` inside the
 * label that wraps its select.
 */
function picker(page: Page, caption: string) {
  return page
    .locator("label")
    .filter({ has: page.locator("span", { hasText: new RegExp(`^${caption}$`, "i") }) })
    .locator("select");
}

/** Ply count off the move-log header both game screens render. */
async function plies(page: Page): Promise<number> {
  const text = (await page.getByText(/Moves\s*·\s*\d+\s*plies/).first().textContent()) ?? "";
  return Number(/(\d+)\s*plies/.exec(text)?.[1] ?? 0);
}

/**
 * A real drag on the board. react-chessboard v5's drag is dnd-kit's
 * PointerSensor with a 1px activation distance, so synthetic mouse events are
 * enough — no library-specific hooks needed.
 *
 * Both squares are measured back to back with nothing scrolling in between. If
 * you centre the destination *after* reading the source, the page scrolls a
 * rank's worth between the two reads and the press lands ~48px off, on an empty
 * square: no drag starts, the move silently never happens, and it reads exactly
 * like the app rejecting a legal move. That cost someone an afternoon once —
 * deployment.md §4, "Measure both ends of a drag in one evaluate".
 */
async function dragPiece(page: Page, from: string, to: string) {
  const source = page.locator(`[data-square="${from}"]`).first();
  const target = page.locator(`[data-square="${to}"]`).first();

  await source.scrollIntoViewIfNeeded();
  const a = await source.boundingBox();
  const b = await target.boundingBox();
  if (!a || !b) throw new Error(`no bounding box for ${from} or ${to}`);

  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
}

/**
 * Drag, then confirm the ply counter actually moved. False means refused.
 *
 * A legal drop updates the counter in the same tick, so the poll window only
 * has to cover render — and it's spent in full on every refused move, of which
 * there are plenty.
 */
async function tryMove(page: Page, from: string, to: string): Promise<boolean> {
  const before = await plies(page);
  await dragPiece(page, from, to);
  try {
    await expect.poll(() => plies(page), { timeout: 400 }).toBeGreaterThan(before);
    return true;
  } catch {
    return false;
  }
}

async function waitForEngineReply(page: Page) {
  await expect(page.getByText(/thinking/i)).toBeHidden({ timeout: 120_000 });
}

/**
 * White's side of a short, sane-looking opening, so the move log in the shot
 * reads like chess rather than the aimless wing pawns `cdp-rating-readout.mjs`
 * plays. The engine's replies aren't predictable, so any of these can be illegal
 * by the time we try it; a refused move just moves on to the next candidate.
 */
const OPENING: Array<[string, string]> = [
  ["e2", "e4"],
  ["g1", "f3"],
  ["f1", "c4"],
  ["d2", "d3"],
  ["b1", "c3"],
  ["c1", "g5"],
  ["d1", "e2"],
  ["e1", "g1"],
  ["h2", "h3"],
  ["a2", "a3"],
];

/**
 * More of the same, drawn on when the opening runs out. Deliberately spread
 * across every piece: each entry is one attempt, a refused attempt is cheap, and
 * what matters is that the pool can't be exhausted by one piece being stuck.
 */
const MORE_MOVES: Array<[string, string]> = [
  ["b2", "b3"],
  ["c2", "c3"],
  ["g2", "g3"],
  ["a3", "a4"],
  ["h3", "h4"],
  ["a1", "b1"],
  ["h1", "e1"],
  ["f1", "e1"],
  ["d1", "d2"],
  ["c1", "e3"],
  ["f3", "d4"],
  ["f3", "e5"],
  ["c3", "d5"],
  ["c3", "e2"],
  ["c4", "d5"],
  ["c4", "b5"],
  ["g5", "h4"],
  ["g5", "f4"],
  ["e2", "d1"],
  ["e2", "f1"],
  ["d3", "d4"],
  ["g1", "h1"],
  ["h1", "g1"],
  ["b3", "b4"],
  ["g3", "g4"],
];

/** True once the rating readout has passed its display gate. */
function ratingVerdict(page: Page) {
  return page.getByText(/plays most like/i);
}

/**
 * Play as White until the rating readout opens up, or we run out of patience.
 *
 * Why not just "play ten moves and screenshot": the gate isn't a move count,
 * it's six *effective* plies, and a ply only counts for as much information as
 * its position carries. Two things came out of watching this fail:
 *
 *  - Ten scripted moves scored 4.2 effective plies. Eighteen scored 5.4. Not a
 *    bug in either the app or the harness — a book opening is the *least*
 *    informative thing a player can do, because 1.e4 Nf3 Bc4 is what every
 *    rating bucket plays, so the posterior learns nearly nothing from it. The
 *    CDP harness's aimless wing pawns opened the gate by move 8 for exactly the
 *    inverse reason.
 *  - So the pool is cycled rather than walked once. A candidate refused in one
 *    position is often legal two moves later, and the later, odder moves are the
 *    ones that carry information.
 *
 * Only the readout knows when it's ready, so ask it rather than guessing a
 * number of moves.
 */
async function playUntilRatingReady(page: Page, minMoves: number, maxMoves: number) {
  const pool = [...OPENING, ...MORE_MOVES];
  let played = 0;

  for (let round = 0; round < 3; round++) {
    for (const [from, to] of pool) {
      if (played >= maxMoves) return played;
      if (played >= minMoves && (await ratingVerdict(page).isVisible())) return played;
      // A finished game stops accepting moves; keep dragging at it and the only
      // thing that grows is the run time.
      if (await page.getByText(/\bwins\b|\bdraw\b/i).first().isVisible()) return played;
      if (await tryMove(page, from, to)) {
        played += 1;
        await waitForEngineReply(page);
      }
    }
  }

  return played;
}

/** Start a game against one engine on /user-1v1, playing White. */
async function startUserGame(page: Page, engineLabel: string) {
  await page.goto("/user-1v1?fx=off");
  await picker(page, "Opponent").selectOption({ label: engineLabel });
  await page.getByRole("button", { name: /start game/i }).click();
  await expect(page.locator('[data-square="e2"]').first()).toBeVisible();
}

/**
 * Four finished games, written straight into the store the history page reads.
 * Playing four games through the UI to photograph a list would cost minutes and
 * tell us nothing the page doesn't already prove — /history's own verification
 * is in `web/scripts/`. Shape is `GameRecord` from `lib/games/types.ts`.
 */
const SEEDED_HISTORY = [
  {
    mode: "model-1v1",
    white: { type: "stockfish", label: "Stockfish 2800" },
    black: { type: "maia", label: "Maia 1900" },
    moves: ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "a6", "Be3", "e5"],
    result: "1-0",
    endReason: "checkmate",
    minutesAgo: 4,
  },
  {
    mode: "user-1v1",
    white: { type: "human", label: "You" },
    black: { type: "maia", label: "Maia 1500" },
    moves: ["d4", "d5", "c4", "e6", "Nc3", "Nf6", "cxd5", "exd5", "Bg5", "Be7"],
    result: "1/2-1/2",
    endReason: "draw-repetition",
    minutesAgo: 26,
  },
  {
    mode: "model-1v1",
    // Labels here must be ones the app really ships (lib/chess/engines.ts) —
    // a screenshot is a claim about the app, and an invented preset name is a
    // false one. This is the Task 15 mixture engine's actual label.
    white: { type: "mixture", label: "Policy Mixture (uncalibrated)" },
    black: { type: "stockfish", label: "Stockfish 1320" },
    moves: ["Nf3", "d5", "d4", "Nf6", "c4", "e6", "Nc3", "Be7", "Bg5", "h6"],
    result: "1-0",
    endReason: "checkmate",
    minutesAgo: 71,
  },
  {
    mode: "user-1v1",
    white: { type: "maia", label: "Maia 1100" },
    black: { type: "human", label: "You" },
    moves: ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6", "O-O", "Be7"],
    result: "0-1",
    endReason: "stalemate",
    minutesAgo: 138,
  },
];

async function seedHistory(page: Page) {
  await page.addInitScript((games) => {
    const now = Date.now();
    const records = games.map((g, i) => ({
      id: `seed-${i}`,
      timestamp: now - g.minutesAgo * 60_000,
      mode: g.mode,
      white: g.white,
      black: g.black,
      moves: g.moves,
      result: g.result,
      endReason: g.endReason,
    }));
    window.localStorage.setItem("er:games", JSON.stringify(records));
  }, SEEDED_HISTORY);
}

// ---------------------------------------------------------------------------
// Desktop
// ---------------------------------------------------------------------------

test("hero — the menu with the Opera Game replaying", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  // The board on the menu loops Morphy 1858. Wait for the header scoreboard to
  // report a few moves in, so the shot isn't of the start position — its
  // aria-label is the only text that carries the live ply.
  await expect
    .poll(
      async () => {
        const label = await page.locator('[aria-label*="Last move"]').first().getAttribute("aria-label");
        return Number(/Move (\d+)/.exec(label ?? "")?.[1] ?? 0);
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThanOrEqual(5);

  await shoot(page, "gallery-hero");
});

test("model 1v1 — two engines mid-fight", async ({ page }) => {
  await page.goto("/model-1v1?fx=off");
  await picker(page, "White").selectOption({ label: "Stockfish 1320" });
  await picker(page, "Black").selectOption({ label: "Stockfish 2800" });
  await page.getByRole("button", { name: /start game/i }).click();

  // ~500ms of thinking plus a 350ms pause per ply, so this is ~15s.
  await expect.poll(() => plies(page), { timeout: 120_000 }).toBeGreaterThanOrEqual(14);
  await shoot(page, "gallery-model-1v1");
});

test("rating readout and odds @maia", async ({ page }) => {
  // Maia's 93 MB cold load, ten player moves, then 30 rollouts played to the end.
  test.setTimeout(12 * 60_000);

  // Stockfish as the opponent so the *opponent's* replies stay fast — the rating
  // estimator loads Maia either way, since it scores the player's own moves
  // against all nine buckets.
  await startUserGame(page, "Stockfish 1320");

  const played = await playUntilRatingReady(page, 8, 28);
  expect(played, "needed player moves for the estimator to have evidence").toBeGreaterThanOrEqual(8);

  // The readout shows nothing until it has enough information to be worth
  // reading. This is that gate opening — and the wait is this long because the
  // 93 MB model has to land before the first ply can be scored at all.
  await expect(ratingVerdict(page)).toBeVisible({ timeout: 6 * 60_000 });

  // Back to the top: the drags leave the page scrolled wherever the last board
  // measurement put it. The move log is a fixed-height box, so the rating block
  // sits at a stable ~560px whatever the ply count — from the top, one frame
  // holds the controls, the log, the board and the readout.
  await page.evaluate(() => window.scrollTo(0, 0));
  await shoot(page, "gallery-rating");

  await page.getByRole("button", { name: /play it out 30×/i }).click();

  // Assert on the summary line under the win/draw/loss rows, not on the button
  // relabelling itself. The button flips as soon as the run ends and it sits
  // *above* the numbers, so waiting on it proves a run finished and proves
  // nothing about whether its result is in the frame.
  const oddsSummary = page.getByText(/\d+ games · Maia/i);
  await expect(oddsSummary).toBeVisible({ timeout: 6 * 60_000 });

  // The odds block is the last thing in the left column, so on a 900-tall frame
  // it lands below the fold — the first version of this shot photographed an
  // empty "Odds from here" heading with the actual numbers cut off.
  await oddsSummary.evaluate((el) => el.scrollIntoView({ block: "end" }));
  await shoot(page, "gallery-odds");
});

test("history — finished games, newest first", async ({ page }) => {
  await seedHistory(page);
  await page.goto("/history");
  await expect(page.getByText(/Stockfish 2800/).first()).toBeVisible();

  // Shorter frame than the rest: four rows end around 460px, so the standard
  // 900 leaves the bottom 40% of the tile empty paper.
  await page.setViewportSize({ width: 1280, height: 620 });
  await shoot(page, "gallery-history");
});

test("night edition", async ({ page }) => {
  // Both halves matter: the inline bootstrap in layout.tsx reads the stored key
  // before first paint, and colorScheme keeps the OS preference from arguing
  // with it.
  await page.addInitScript(() => window.localStorage.setItem("er-theme", "dark"));
  await page.emulateMedia({ colorScheme: "dark" });

  await page.goto("/model-1v1?fx=off");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  // Deeper into a game than the day shot, and different presets, so the two
  // aren't the same photograph twice. A pre-game screen would have been the
  // cheap option and it reads as an empty page: "No moves yet.", 0 plies.
  await picker(page, "White").selectOption({ label: "Stockfish 1800" });
  await picker(page, "Black").selectOption({ label: "Stockfish 2800" });
  await page.getByRole("button", { name: /start game/i }).click();
  await expect.poll(() => plies(page), { timeout: 180_000 }).toBeGreaterThanOrEqual(24);

  await shoot(page, "gallery-night");
});

// ---------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------

test.describe("phone", () => {
  // Viewport only, no `isMobile`. Mobile emulation changes how pointer input is
  // synthesized, and one of these shots has to complete a drag on the board.
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });

  test("mobile hero", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // The hero's replay is ReplayBoard, a hand-built grid — no `data-square`
    // attributes, unlike the react-chessboard the game screens use.
    await expect(page.locator('[aria-label*="replaying the Opera Game"]')).toBeVisible();
    // No ply readout to wait on here — the header scoreboard is `max-sm:hidden`,
    // so on a phone the replay has no visible progress marker. A plain wait is
    // enough for a still: the loop moves every ~1.15s.
    await page.waitForTimeout(5_000);
    await shoot(page, "gallery-mobile-hero");
  });

  test("mobile user 1v1 @maia", async ({ page }) => {
    test.setTimeout(12 * 60_000);
    await startUserGame(page, "Stockfish 1320");

    // This shot has to wait out Maia's load whether we want it to or not: the
    // player's first move starts the rating estimator, and until the 93 MB
    // lands the panel reads "Loading the move model…". Stopping short here
    // photographs that line, so we may as well spend the time and come away
    // with the readout itself.
    const played = await playUntilRatingReady(page, 8, 28);
    expect(played).toBeGreaterThanOrEqual(8);
    await expect(ratingVerdict(page)).toBeVisible({ timeout: 6 * 60_000 });

    // Anchor the readout to the top of the frame. The drags leave the page
    // scrolled wherever the last board measurement put it, and on a phone the
    // layout is one column — readout, then odds, then board — so `start` fits
    // the whole readout *and* most of the board. `center` spends the top third
    // of the shot on the move log and cuts the board to three ranks.
    await ratingVerdict(page).evaluate((el) => el.scrollIntoView({ block: "start" }));
    await shoot(page, "gallery-mobile-user");
  });

  test("mobile history", async ({ page }) => {
    await seedHistory(page);
    await page.goto("/history");
    await expect(page.getByText(/Stockfish 2800/).first()).toBeVisible();
    await shoot(page, "gallery-mobile-history");
  });
});
