// Verification check 4: are the fixture rows actually what they claim to be?
//
// Every number the audit prints rests on one assumption that nothing else checks:
// that `fen` in each row really is the position the human was looking at when
// they played `move`, and that `moverRating` really is that human's rating. An
// off-by-one ply would satisfy every other check in the project - the FENs would
// be legal, the moves would be legal, Maia would happily score them - and quietly
// contaminate thousands of rows with "what did the *opponent* do next".
//
// So this replays the stored source PGNs from scratch, with a fresh chess.js and
// a hand-written replay that does NOT go through the builder's extraction path,
// and confirms the rows line up. Different code reaching the same answer is the
// point; importing the builder's own function here would prove nothing.
//
// usage: node scripts/verify-calibration-fixture.mjs

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Chess } from "chess.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(HERE, "fixtures/maia-calibration-sample.jsonl");
const SPOT = resolve(HERE, "fixtures/maia-calibration-spotcheck.json");

const checks = [];
function check(label, ok, detail) {
  checks.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`);
}

const rows = (await readFile(SAMPLE, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
const spotChecks = JSON.parse(await readFile(SPOT, "utf8"));

// ── 1. the whole corpus: cheap invariants on every single row ────────────────
// Not in the spec, which asks only for ~10 hand-checked rows. These cost a second
// for all 3,964 and catch the same class of bug across the whole file rather than
// in a sample of it - the hand-check below is then about provenance, which this
// cannot see.

console.log(`== every row (${rows.length}) ==`);

let illegal = 0;
let ratingMismatch = 0;
let badFen = 0;
const seen = new Set();
let duplicates = 0;

for (const row of rows) {
  let board;
  try {
    board = new Chess(row.fen);
  } catch {
    badFen++;
    continue;
  }
  const legal = board
    .moves({ verbose: true })
    .some((m) => `${m.from}${m.to}${m.promotion ?? ""}` === row.move);
  if (!legal) illegal++;

  // The mover's rating has to belong to the side to move. This is the assertion
  // that an off-by-one ply breaks, because the parity of `ply` and the FEN's
  // side-to-move field would stop agreeing.
  const whiteToMove = row.fen.split(" ")[1] === "w";
  if (whiteToMove !== (row.ply % 2 === 0)) ratingMismatch++;

  const key = `${row.game}#${row.ply}`;
  if (seen.has(key)) duplicates++;
  seen.add(key);
}

check("every stored FEN parses", badFen === 0, `${badFen} unparseable`);
check("every stored move is legal at its stored FEN", illegal === 0, `${illegal} illegal`);
check(
  "side to move always matches ply parity (the off-by-one detector)",
  ratingMismatch === 0,
  `${ratingMismatch} rows where the FEN's side to move disagrees with the ply index`,
);
check("no duplicated (game, ply) rows", duplicates === 0, `${duplicates} duplicates`);

const ratings = rows.flatMap((r) => [r.moverRating, r.opponentRating]);
check(
  "all ratings are plausible Glicko-2 numbers",
  ratings.every((r) => Number.isInteger(r) && r > 100 && r < 3500),
  `range ${Math.min(...ratings)}-${Math.max(...ratings)}`,
);

// ── 2. the spot check: re-derive rows from their source PGN ──────────────────

console.log(`\n== ${spotChecks.length} rows re-derived from their source PGN ==`);

for (const { row, pgn } of spotChecks) {
  // A deliberately naive replay: parse the movetext by hand, push SAN one at a
  // time, and snapshot the FEN *before* the move at the stored ply. This is the
  // independent path - if the builder's use of verbose history's `before` field
  // were subtly wrong, this would disagree with it.
  const movetext = pgn
    .split("\n")
    .filter((line) => !line.startsWith("["))
    .join(" ")
    .replace(/\{[^}]*\}/g, " ")      // clock and eval comments
    .replace(/\d+\.(\.\.)?/g, " ")   // move numbers, including "1..." continuations
    .replace(/\s+/g, " ")
    .trim();

  const tokens = movetext.split(" ").filter((t) => t && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t));

  const board = new Chess();
  let fenBefore = null;
  let playedUci = null;
  for (let ply = 0; ply < tokens.length; ply++) {
    if (ply === row.ply) fenBefore = board.fen();
    const move = board.move(tokens[ply]);
    if (ply === row.ply) {
      playedUci = `${move.from}${move.to}${move.promotion ?? ""}`;
      break;
    }
  }

  const headers = Object.fromEntries(
    [...pgn.matchAll(/^\[(\w+)\s+"(.*)"\]$/gm)].map((m) => [m[1], m[2]]),
  );
  const expectedMover = row.ply % 2 === 0 ? Number(headers.WhiteElo) : Number(headers.BlackElo);

  const ok = fenBefore === row.fen && playedUci === row.move && expectedMover === row.moverRating;
  check(
    `${row.game} ply ${row.ply}: FEN, move and rating all re-derive`,
    ok,
    ok
      ? `${row.move} at ${row.fen.split(" ").slice(0, 2).join(" ")} (${row.moverRating})`
      : `stored fen  ${row.fen}\n        replay fen  ${fenBefore}\n` +
        `        stored move ${row.move}   replay move ${playedUci}\n` +
        `        stored rating ${row.moverRating}   header rating ${expectedMover}`,
  );
}

const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exitCode = failed ? 1 : 0;
