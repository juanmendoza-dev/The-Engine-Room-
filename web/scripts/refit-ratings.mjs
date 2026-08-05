// Rebuild lib/analysis/fixtures/ratings.json from games-log.jsonl, from scratch.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/refit-ratings.mjs [--dedupe]
//
// `sprt-run.mjs` already refits after each match, incrementally. This is the
// from-scratch version, and it exists because the spec calls ratings.json "a
// cache, not a second source of truth" — a claim that should be executable
// rather than aspirational. Every number in that file, including each SPRT run's
// terminal state, is recomputed here by replaying the log. Delete ratings.json
// and this puts it back.
//
// `--dedupe` additionally rewrites the log with exact duplicate games removed,
// keeping the first occurrence.
//
// **Why duplicates happen, and why they are not harmless.** Both engines are
// near-deterministic, so the same opening played by the same two presets with
// the same colours produces the identical game. The first runs here sampled
// openings *with* replacement: 17 opening draws over a 21-line book collide
// about a third of the time, and Maia 1900 vs Maia 1100 logged 34 games of which
// 22 were distinct. A duplicate carries no information but counts as evidence,
// so the SPRT's LLR advances on it and the interval it reports is too narrow.
// The match runner now deals openings from a shuffled deck, which makes it
// impossible inside one match; this cleans up what predates that.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";

register("./ts-extension-resolver.mjs", import.meta.url);

const { fitBradleyTerryDavidson } = await import("../lib/analysis/ratingBT.ts");
const { createSprt, outcomeFor, recordGame } = await import("../lib/analysis/sprt.ts");

const DEDUPE = process.argv.includes("--dedupe");

const FIXTURES = new URL("../lib/analysis/fixtures/", import.meta.url);
const GAMES_LOG = new URL("games-log.jsonl", FIXTURES);
const RATINGS = new URL("ratings.json", FIXTURES);

/** Per the spec: the mid preset, away from either end of Stockfish's clamp. */
const ANCHOR_PRESET = "Stockfish 1800";

if (!existsSync(GAMES_LOG)) {
  console.log("no games-log.jsonl — nothing to refit");
  process.exit(1);
}

let games = readFileSync(GAMES_LOG, "utf8")
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

const keyOf = (g) => `${g.white}|${g.black}|${g.moves.join(" ")}`;

const seen = new Set();
const unique = games.filter((g) => {
  const k = keyOf(g);
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
const duplicates = games.length - unique.length;

console.log(`${games.length} games in the log, ${duplicates} of them exact duplicates`);

if (DEDUPE && duplicates > 0) {
  writeFileSync(GAMES_LOG, `${unique.map((g) => JSON.stringify(g)).join("\n")}\n`, "utf8");
  console.log(`rewrote games-log.jsonl with ${unique.length} games`);
  games = unique;
} else if (duplicates > 0) {
  console.log("(pass --dedupe to remove them; fitting on the deduplicated set regardless)");
  games = unique;
}

// --- Per-run SPRT terminal states, replayed rather than trusted --------------

const previous = existsSync(RATINGS) ? JSON.parse(readFileSync(RATINGS, "utf8")) : { runs: [] };
const configs = new Map((previous.runs ?? []).map((r) => [r.runId, r]));

const byRun = new Map();
for (const g of games) {
  if (!g.runId) continue;
  if (!byRun.has(g.runId)) byRun.set(g.runId, []);
  byRun.get(g.runId).push(g);
}

const runs = [];
for (const [runId, runGames] of byRun) {
  const stored = configs.get(runId);
  if (!stored?.config) {
    console.log(`  ! ${runId}: no stored config, can't replay its SPRT — logging counts only`);
    runs.push({ runId, games: runGames.length, replayed: false });
    continue;
  }

  runGames.sort((x, y) => x.timestamp - y.timestamp);
  const { a, b, elo0, elo1, alpha, beta, gamma, maxGames } = stored.config;
  let state = createSprt({ a, b, elo0, elo1, alpha, beta, gamma, maxGames });
  for (const g of runGames) state = recordGame(state, outcomeFor(a, g.white, g.black, g.result));

  const changed = stored.llr !== undefined && Math.abs(stored.llr - state.llr) > 1e-9;
  runs.push({
    runId,
    config: stored.config,
    decision: state.decision,
    llr: state.llr,
    games: state.games,
    wins: state.wins,
    draws: state.draws,
    losses: state.losses,
    status: stored.status,
    complete: stored.complete,
    elapsedMs: stored.elapsedMs,
    startedAt: stored.startedAt,
    replayed: true,
    // Flagged rather than silently corrected: a run whose stored LLR disagrees
    // with a replay of its own games was scored on games that are no longer in
    // the log — duplicates, in practice — so its original decision was reached
    // on evidence it did not have.
    ...(changed ? { originalLlr: stored.llr, originalGames: stored.games } : {}),
  });

  if (changed) {
    console.log(
      `  ! ${runId}: replayed LLR ${state.llr.toFixed(3)} over ${state.games} games, ` +
        `stored was ${stored.llr.toFixed(3)} over ${stored.games} — ${stored.decision} → ${state.decision}`,
    );
  }
}

// --- Pooled fit --------------------------------------------------------------

const presetIds = [...new Set(games.flatMap((g) => [g.white, g.black]))].sort();
const anchorPresent = presetIds.includes(ANCHOR_PRESET);
const anchorId = anchorPresent ? ANCHOR_PRESET : presetIds[0];
const parsed = /(\d{3,4})/.exec(anchorId);
const anchorElo = anchorPresent ? 1800 : parsed ? Number(parsed[1]) : 1500;

const pooled = fitBradleyTerryDavidson(games, presetIds, anchorId, anchorElo);

const payload = {
  generatedAt: new Date().toISOString(),
  note:
    "Derived from games-log.jsonl — a cache, not a second source of truth. " +
    "Rebuild with scripts/refit-ratings.mjs; sprt-run.mjs updates it after each match.",
  anchor: { presetId: anchorId, elo: anchorElo, substituted: !anchorPresent },
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

console.log(`\npooled fit over ${games.length} games, anchored on ${anchorId} = ${anchorElo}:`);
for (const r of pooled.ratings) {
  console.log(
    `  ${r.presetId.padEnd(16)} ${r.rated ? `${r.elo.toFixed(1)} Elo` : "unrated"}` +
      `${r.stderr !== null ? ` ±${r.stderr.toFixed(1)}` : ""}  (${r.score}/${r.games})` +
      `${r.note ? `  — ${r.note}` : ""}`,
  );
}
console.log(
  `  gamma ${pooled.drawParam.toFixed(3)}` +
    (pooled.drawParamStderr ? ` ±${pooled.drawParamStderr.toFixed(3)}` : "") +
    `  (converged=${pooled.converged}, ${pooled.iterations} iterations)`,
);
for (const w of pooled.warnings) console.log(`  ! ${w}`);
console.log("\ndone");
