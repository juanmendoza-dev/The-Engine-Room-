// Drives /dev/match-runner in a headless Chrome, then writes what came back into
// lib/analysis/fixtures/. Zero dependencies — Node 22+ has fetch and WebSocket.
//
// The page plays and this collects, the same split every other harness in here
// uses: `engineStockfish.ts` needs a real Worker and `engineMaia.ts` refuses to
// load outside a browser, so a Node script cannot play the games itself however
// much it would simplify this.
//
// usage:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     scripts/sprt-run.mjs <match-runner-url> [timeout-ms] [cdp-port] [--dry-run]
//
// The flag is cosmetic: regenerating ratings.json imports `ratingBT.ts` under
// Node, and `web/package.json` has no `"type": "module"`, so Node warns that it
// reparsed the file as ESM. Harmless, but it prints in the middle of the results.
//
// Chrome must already be running with --remote-debugging-port on that port and
// the target URL as a launch argument. Both requirements are load-bearing, per
// docs/deployment.md §4: Page.navigate can return cleanly and leave the tab on
// about:blank, and the URL must use `localhost` rather than 127.0.0.1 or Next
// blocks its own dev resources and the page never hydrates.
//
// Build the URL with the match config in the query string, e.g.
//   http://localhost:3000/dev/match-runner?a=Stockfish%202800&b=Stockfish%201320&elo1=200&maxGames=24
//
// Budget the wall clock before starting one of these. At MOVE_TIME_MS=500 and
// ~70 plies, a Stockfish-vs-Stockfish game is ~35s of thinking: ~13 min for a
// 22-game sanity check, ~3 hours for a 320-game precision run. Maia-vs-Maia is
// ~2.5s a game. There is no parallelism to lean on — engineStockfish.ts is one
// shared Worker behind a promise queue, so two games in one tab would interleave
// onto it rather than go faster.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const positional = args.filter((a) => !a.startsWith("--"));
const [
  TARGET_URL = "http://localhost:3000/dev/match-runner",
  TIMEOUT_MS = "1800000",
  PORT = "9222",
] = positional;

const FIXTURES = new URL("../lib/analysis/fixtures/", import.meta.url);
const GAMES_LOG = new URL("games-log.jsonl", FIXTURES);
const RATINGS = new URL("ratings.json", FIXTURES);

/** Per the spec: the mid preset, away from either end of Stockfish's clamp. */
const ANCHOR_PRESET = "Stockfish 1800";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- CDP --------------------------------------------------------------------

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const res = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
    return res.result?.value;
  }
}

async function findPageTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* browser not up yet */
    }
    await sleep(500);
  }
  throw new Error(`no CDP page target on port ${PORT} — is Chrome running with --remote-debugging-port?`);
}

// --- Fixture writing --------------------------------------------------------

function readGamesLog() {
  if (!existsSync(GAMES_LOG)) return [];
  return readFileSync(GAMES_LOG, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/**
 * The anchor pins the scale's zero point; everything else is measured relative
 * to it. `Stockfish 1800` at 1800 by definition — the spec is explicit that this
 * is a *choice*, not a claim the preset has been verified against any external
 * human pool. Relative gaps are the honest deliverable.
 */
function anchorFor(presetIds) {
  if (presetIds.includes(ANCHOR_PRESET)) return { id: ANCHOR_PRESET, elo: 1800, substituted: false };
  const fallback = presetIds[0];
  const parsed = /(\d{3,4})/.exec(fallback);
  return { id: fallback, elo: parsed ? Number(parsed[1]) : 1500, substituted: true };
}

async function regenerateRatings(newRun) {
  register("./ts-extension-resolver.mjs", import.meta.url);
  const { fitBradleyTerryDavidson } = await import("../lib/analysis/ratingBT.ts");

  const games = readGamesLog();
  const presetIds = [...new Set(games.flatMap((g) => [g.white, g.black]))].sort();
  const anchor = anchorFor(presetIds);

  // γ is *fitted* here, unlike inside a single match: this is the pooled data the
  // spec means when it calls γ a nuisance parameter estimated once from
  // everything, and a few hundred games across several pairings can actually
  // support estimating it.
  const pooled = fitBradleyTerryDavidson(games, presetIds, anchor.id, anchor.elo);

  const previous = existsSync(RATINGS) ? JSON.parse(readFileSync(RATINGS, "utf8")) : { runs: [] };
  const runs = (previous.runs ?? []).filter((r) => r.runId !== newRun?.runId);
  if (newRun) runs.push(newRun);

  const payload = {
    generatedAt: new Date().toISOString(),
    note:
      "Derived from games-log.jsonl — a cache, not a second source of truth. " +
      "Regenerate with scripts/sprt-run.mjs, or by refitting the log.",
    anchor: { presetId: anchor.id, elo: anchor.elo, substituted: anchor.substituted },
    pooled: {
      ratings: pooled.ratings,
      drawParam: pooled.drawParam,
      drawParamStderr: pooled.drawParamStderr,
      converged: pooled.converged,
      iterations: pooled.iterations,
      gamesUsed: pooled.gamesUsed,
      warnings: pooled.warnings,
    },
    runs,
  };

  writeFileSync(RATINGS, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

// --- Main -------------------------------------------------------------------

const target = await findPageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", () => reject(new Error("CDP websocket failed")), { once: true });
});

const cdp = new Cdp(ws);
await cdp.send("Runtime.enable");
await cdp.send("Log.enable");
await cdp.send("Page.enable");

// Chrome loaded its launch-arg URL before this websocket existed, so anything the
// page logged on the way up has already come and gone unheard. Reload now that
// Runtime is enabled — and re-issue the navigation until location.href actually
// reports the target, because Page.navigate can quietly park on about:blank.
for (let i = 0; i < 10; i++) {
  const href = await cdp.evaluate("location.href").catch(() => "");
  if (typeof href === "string" && href.startsWith(TARGET_URL.split("?")[0])) break;
  await cdp.send("Page.navigate", { url: TARGET_URL });
  await sleep(1000);
}
await cdp.send("Page.reload", { ignoreCache: false });

console.log(`driving ${TARGET_URL}`);
console.log(`timeout ${Math.round(Number(TIMEOUT_MS) / 1000)}s, cdp port ${PORT}`);

const deadline = Date.now() + Number(TIMEOUT_MS);
let result = null;
let lastLine = "";

while (Date.now() < deadline) {
  await sleep(3000);
  try {
    result = await cdp.evaluate("window.__SPRT_RESULT__ ?? null");
    if (result) break;
    const text = await cdp.evaluate("document.body ? document.body.innerText : ''");
    const line = String(text).split("\n").filter(Boolean).slice(-2).join(" | ");
    if (line && line !== lastLine) {
      lastLine = line;
      console.log(`  ${line}`);
    }
    if (String(text).includes("error:")) break;
  } catch {
    /* mid-navigation or mid-reload; try again */
  }
}

console.log("\n=== CONSOLE ERRORS / EXCEPTIONS ===");
let sawProblem = false;
for (const e of cdp.events) {
  if (e.method === "Runtime.exceptionThrown") {
    sawProblem = true;
    const d = e.params.exceptionDetails;
    console.log("EXCEPTION:", d?.exception?.description ?? d?.text ?? JSON.stringify(d));
  }
  if (e.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(e.params.type)) {
    sawProblem = true;
    console.log(
      `${e.params.type.toUpperCase()}:`,
      e.params.args.map((a) => a.value ?? a.description ?? "").join(" "),
    );
  }
  if (e.method === "Log.entryAdded" && e.params.entry.level === "error") {
    sawProblem = true;
    console.log("LOG-ERROR:", e.params.entry.text);
  }
}
if (!sawProblem) console.log("(none)");

ws.close();

if (!result) {
  console.log("\n=== NO RESULT (timed out or the page errored) ===");
  process.exit(1);
}

console.log("\n=== MATCH ===");
console.log(`${result.config.a} vs ${result.config.b}`);
console.log(
  `${result.finalSprt.wins}W ${result.finalSprt.draws}D ${result.finalSprt.losses}L over ` +
    `${result.games.length} games in ${(result.elapsedMs / 1000).toFixed(1)}s`,
);
console.log(
  `LLR ${result.finalSprt.llr.toFixed(3)} in [${result.finalSprt.boundB.toFixed(3)}, ` +
    `${result.finalSprt.boundA.toFixed(3)}] → ${result.finalSprt.decision}`,
);
console.log(
  result.deltaElo === null
    ? "measured gap: not rateable from these games"
    : `measured gap: ${result.deltaElo >= 0 ? "+" : ""}${result.deltaElo.toFixed(1)} Elo` +
        (result.deltaStderr === null ? "" : ` ± ${result.deltaStderr.toFixed(1)}`),
);
if (result.error) console.log(`run error: ${result.error}`);

if (DRY_RUN) {
  console.log("\n--dry-run: nothing written");
  console.log("done");
  process.exit(0);
}

mkdirSync(fileURLToPath(FIXTURES), { recursive: true });

// Newline-delimited so a new match is a pure append rather than a rewrite of a
// growing array — small diffs, and a crashed run can't corrupt earlier games.
const lines = result.games.map((g) => JSON.stringify(g)).join("\n");
if (lines) appendFileSync(GAMES_LOG, `${lines}\n`, "utf8");

const ratings = await regenerateRatings({
  runId: result.runId,
  config: result.config,
  decision: result.finalSprt.decision,
  llr: result.finalSprt.llr,
  games: result.finalSprt.games,
  wins: result.finalSprt.wins,
  draws: result.finalSprt.draws,
  losses: result.finalSprt.losses,
  status: result.status,
  complete: result.complete,
  elapsedMs: result.elapsedMs,
  startedAt: new Date(result.startedAt).toISOString(),
});

console.log(`\nwrote ${result.games.length} games to lib/analysis/fixtures/games-log.jsonl`);
console.log("pooled fit across everything logged so far:");
for (const r of ratings.pooled.ratings) {
  console.log(
    `  ${r.presetId.padEnd(16)} ${r.rated ? `${r.elo.toFixed(1)} Elo` : "unrated"}` +
      `${r.stderr !== null ? ` ±${r.stderr.toFixed(1)}` : ""}  (${r.score}/${r.games})` +
      `${r.note ? `  — ${r.note}` : ""}`,
  );
}
console.log(
  `  gamma ${ratings.pooled.drawParam.toFixed(3)}` +
    (ratings.pooled.drawParamStderr ? ` ±${ratings.pooled.drawParamStderr.toFixed(3)}` : ""),
);
for (const w of ratings.pooled.warnings) console.log(`  ! ${w}`);

console.log("done");
