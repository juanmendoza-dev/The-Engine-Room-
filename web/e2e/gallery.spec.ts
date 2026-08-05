/**
 * The README gallery, shot from the real app.
 *
 * Each test writes one `docs/assets/gallery-*.png`. They're tests only because
 * @playwright/test gives us fixtures, timeouts and retries for free — the
 * assertions exist to make a shot fail loudly rather than quietly photograph a
 * loading spinner. Nothing here verifies app behaviour; that's still the CDP
 * harnesses in `web/scripts/`.
 *
 *   npm run shots                       # all of them
 *   npm run shots -- --grep @maia       # just the two that need the model
 *   npm run shots -- --grep-invert @maia
 *
 * The two @maia shots pay a ~93 MB model download and then play 30 games out;
 * budget several minutes for them and expect the rest to be seconds.
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

/** Drag, then confirm the ply counter actually moved. False means refused. */
async function tryMove(page: Page, from: string, to: string): Promise<boolean> {
  const before = await plies(page);
  await dragPiece(page, from, to);
  try {
    await expect.poll(() => plies(page), { timeout: 5_000 }).toBeGreaterThan(before);
    return true;
  } catch {
    return false;
  }
}

async function waitForEngineReply(page: Page) {
  await expect(page.getByText(/thinking/i)).toBeHidden({ timeout: 120_000 });
}

/**
 * White's side of a short, sane-looking opening. The engine's replies aren't
 * predictable, so any of these can turn out illegal on the day — a refused move
 * falls through to a wing pawn instead of failing the shot. That's the tradeoff
 * for a move log that reads like chess: `cdp-rating-readout.mjs` plays nothing
 * but wing pawns for exactly this reason and the log shows it.
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

const FALLBACKS: Array<[string, string]> = [
  ["a2", "a3"],
  ["h2", "h3"],
  ["b2", "b3"],
  ["g2", "g3"],
  ["a3", "a4"],
  ["h3", "h4"],
  ["b3", "b4"],
  ["g3", "g4"],
];

/** Play `count` moves as White, preferring the opening, falling back to pawns. */
async function playAsWhite(page: Page, count: number) {
  const spent = new Set<string>();
  let played = 0;

  for (const [from, to] of OPENING) {
    if (played >= count) break;
    if (await tryMove(page, from, to)) {
      played += 1;
      spent.add(`${from}${to}`);
      await waitForEngineReply(page);
    }
  }

  for (const [from, to] of FALLBACKS) {
    if (played >= count) break;
    if (spent.has(`${from}${to}`)) continue;
    if (await tryMove(page, from, to)) {
      played += 1;
      await waitForEngineReply(page);
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
    white: { type: "mixture", label: "Stockfish × Maia" },
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

  const played = await playAsWhite(page, 10);
  expect(played, "needed player moves for the estimator to have evidence").toBeGreaterThanOrEqual(8);

  // The readout shows nothing until it has enough information to be worth
  // reading — around six effective plies. This is that gate opening.
  await expect(page.getByText(/plays most like/i)).toBeVisible({ timeout: 6 * 60_000 });
  await shoot(page, "gallery-rating");

  await page.getByRole("button", { name: /play it out 30×/i }).click();
  await expect(page.getByRole("button", { name: /play it out again/i })).toBeVisible({
    timeout: 6 * 60_000,
  });
  await shoot(page, "gallery-odds");
});

test("history — finished games, newest first", async ({ page }) => {
  await seedHistory(page);
  await page.goto("/history");
  await expect(page.getByText(/Stockfish 2800/).first()).toBeVisible();
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
    const played = await playAsWhite(page, 10);
    expect(played).toBeGreaterThanOrEqual(8);
    await expect(page.getByText(/plays most like/i)).toBeVisible({ timeout: 6 * 60_000 });

    // Centre the readout: the drags left the page scrolled wherever the last
    // board measurement put it, and the board sits directly below this, so
    // centring here frames both.
    await page
      .getByText(/plays most like/i)
      .evaluate((el) => el.scrollIntoView({ block: "center" }));
    await shoot(page, "gallery-mobile-user");
  });

  test("mobile history", async ({ page }) => {
    await seedHistory(page);
    await page.goto("/history");
    await expect(page.getByText(/Stockfish 2800/).first()).toBeVisible();
    await shoot(page, "gallery-mobile-history");
  });
});
