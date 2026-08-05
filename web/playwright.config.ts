import { defineConfig } from "@playwright/test";

/**
 * Playwright is here for one job: shooting the README gallery. It is not a test
 * suite — the app's verification harnesses are still the CDP scripts in
 * `web/scripts/`, and nothing in `web/e2e/` asserts anything about behaviour
 * beyond "the screen I want to photograph actually arrived".
 *
 * Run it with `npm run shots` from `web/`.
 *
 * Port 3200, not 3000: several agents work this repo in parallel and a
 * screenshot run that silently attaches to somebody else's `next start` would
 * photograph their build. deployment.md §4 has the long version of that trap.
 */
const PORT = 3200;

export default defineConfig({
  testDir: "./e2e",

  // One at a time, deliberately. Every browser context pays Maia's 93 MB cold
  // load separately (it's a module-level singleton per tab), so parallel shots
  // mean parallel 93 MB downloads competing for the same bandwidth.
  workers: 1,
  fullyParallel: false,

  // The rating shot depends on how much information the engine's replies leave
  // in the position, which isn't ours to control. One retry rather than a
  // hand-tuned move list that works on one game.
  retries: 1,

  // Nothing here is quick. The odds shot plays 30 games out at ~25ms a position,
  // and it can't start until Maia has loaded.
  timeout: 6 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],

  use: {
    // localhost, never 127.0.0.1 — Next 16 treats the IPv4 literal as a
    // cross-origin host, blocks its own /_next resources, and the page then
    // renders perfectly and never hydrates. Every click becomes a no-op with a
    // clean console. Only matters against `next dev`, but the habit is cheap.
    baseURL: `http://localhost:${PORT}`,

    // The app opts out of all fight FX and route transitions under reduced
    // motion, which is what we want for a still: no half-finished ink splatter
    // over the board, no press platen mid-drop.
    //
    // Via contextOptions, not as a top-level `use` key: `reducedMotion` is a
    // BrowserContext option and @playwright/test 1.62 doesn't surface it in
    // UseOptions, so `use: { reducedMotion }` is a type error — and one you only
    // see when `next build` type-checks this file, since Playwright itself never
    // type-checks anything.
    contextOptions: { reducedMotion: "reduce" },

    // Day edition is the default; the night shot overrides both of these.
    colorScheme: "light",

    // 900 tall, not 800: at 800 the board's bottom rank and its file letters
    // clip against the fold on both game screens.
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2,
  },

  webServer: {
    // The production build, not `next dev` — same reason the CDP harnesses use
    // it. It's what Vercel runs, and `web/public/` is snapshotted at build time
    // so a dev-server shot can disagree with the live site about the engines.
    command: "npm run build && npm run start",
    url: `http://localhost:${PORT}`,
    env: { PORT: String(PORT) },
    // Reuses a server already on 3200 — which also means it skips the rebuild.
    // Iterating on e2e/ that's what you want; after touching app code, stop the
    // old server first or you'll shoot the previous build.
    reuseExistingServer: true,
    timeout: 5 * 60_000,
    stdout: "pipe",
  },
});
