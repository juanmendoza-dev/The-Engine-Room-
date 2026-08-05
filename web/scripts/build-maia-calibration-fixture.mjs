// Builds the human corpus the calibration audit scores Maia against.
//
// The question the audit asks - "when maia_rapid.onnx says 30%, do humans at
// that rating bucket really play that move 30% of the time?" - needs (position,
// move actually played, mover's rating) rows from real humans. This app can't
// produce them: GameRecord has no rating field, localStore caps at 50 records
// per browser, and most of what it does record is engine-vs-engine.
//
// So the rows come from the Lichess open database, which publishes every rated
// game on the site monthly under CC0 ("download, modify and redistribute them,
// without asking for permission"). Two things about that source shape this
// script:
//
//  - The monthly file is ~28 GB compressed and holds every speed category mixed
//    together. We need a few thousand *rapid* rows, so this streams the file and
//    hangs up the connection the moment it has enough. Nothing is ever stored on
//    disk except the derived rows. Consequence worth stating plainly: the sample
//    is the first N rapid games of the month, not a uniform draw from it.
//  - The shipped weight is literally named maia_rapid.onnx, so the sample is
//    filtered to Event "Rated Rapid game". Score a blitz sample against it and
//    every number in the audit is quietly measuring the wrong thing.
//
// One frame only, and it sets the ceiling on --rows. The dumps are written as a
// sequence of zstd frames, and Node's createZstdDecompress ends cleanly at the
// end of the first one instead of continuing into the next. That is a soft cap
// of ~14,000 games per run - about 4,000 rows at 2 plies/game, which happens to
// be the sample size this audit wants, so it is documented rather than fixed.
// Asking for many more rows will stop short and say so; picking up frame 2 is
// the work that would be needed, not a bigger --maxBytes.
//
// Move extraction goes through chess.js's own loadPgn - the project's single
// rules authority - rather than a second hand-rolled PGN parser, and reads the
// pre-move FEN straight off verbose history rather than replaying by hand. That
// is what makes the off-by-one-ply class of bug hard to write here; --selftest
// and the spot-check file are what catch it if one gets written anyway.
//
// usage:
//   node scripts/build-maia-calibration-fixture.mjs                # defaults
//   node scripts/build-maia-calibration-fixture.mjs --month 2026-05 --rows 4000
//   node scripts/build-maia-calibration-fixture.mjs --selftest     # no network

import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Transform } from "node:stream";
import { createInterface } from "node:readline";
import { createZstdDecompress } from "node:zlib";

import { Chess } from "chess.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// ── options ──────────────────────────────────────────────────────────────────

function readArgs(argv) {
  const opts = {
    month: "2026-06",
    rows: 4000,
    pliesPerGame: 2,
    seed: 20260805,
    minPlies: 20,
    spotCheck: 10,
    maxBytes: 400_000_000,
    out: resolve(HERE, "fixtures/maia-calibration-sample.jsonl"),
    selftest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--selftest") opts.selftest = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[++i];
      if (!(key in opts)) throw new Error(`unknown option ${arg}`);
      opts[key] = typeof opts[key] === "number" ? Number(value) : value;
    }
  }
  return opts;
}

const opts = readArgs(process.argv.slice(2));
const SPOT_CHECK_PATH = resolve(dirname(opts.out), "maia-calibration-spotcheck.json");
const SOURCE_URL = `https://database.lichess.org/standard/lichess_db_standard_rated_${opts.month}.pgn.zst`;

// Seeded so a rebuild with the same month and seed reproduces the same rows.
// mulberry32 - 5 lines, no dependency, and its quality is irrelevant here: it
// only decides which plies of a game to keep.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── PGN → rows ───────────────────────────────────────────────────────────────

const HEADER_RE = /^\[(\w+)\s+"(.*)"\]$/;

function parseHeaders(headerLines) {
  const headers = {};
  for (const line of headerLines) {
    const match = HEADER_RE.exec(line);
    if (match) headers[match[1]] = match[2];
  }
  return headers;
}

/**
 * Is this a game we can score? Rejects are all about not contaminating the
 * sample rather than about PGN validity:
 *
 *  - non-rapid: the weight is the rapid one (see header comment)
 *  - missing/unrated Elo: there is no rating label to bucket by
 *  - abandoned or very short: a game that ended on move 3 by disconnect is
 *    mostly book, and its "moves" say nothing about how its players choose
 */
function isUsableGame(headers, plyCount) {
  if (!headers.Event?.includes("Rapid")) return false;
  if (headers.Termination === "Abandoned") return false;
  const white = Number(headers.WhiteElo);
  const black = Number(headers.BlackElo);
  if (!Number.isFinite(white) || !Number.isFinite(black)) return false;
  if (white <= 0 || black <= 0) return false;
  return plyCount >= opts.minPlies;
}

/** `https://lichess.org/abcd1234` -> `abcd1234`, for provenance in each row. */
function gameId(headers) {
  return headers.Site?.split("/").pop() ?? "";
}

/**
 * One game's PGN text -> up to `pliesPerGame` rows.
 *
 * Positions inside a single game are not independent draws - they share players,
 * an opening and a middlegame plan - so a long game is capped at a couple of
 * plies rather than being allowed to dominate the corpus with 80 correlated rows.
 *
 * `before` and `lan` come off chess.js's verbose history, so the FEN stored is
 * by construction the position the human was looking at when they chose the move
 * stored beside it. Deriving both from the same Move object is the point: a
 * hand-rolled replay is where an off-by-one ply gets in.
 */
function rowsFromGame(pgn, rng) {
  const chess = new Chess();
  chess.loadPgn(pgn);
  const history = chess.history({ verbose: true });

  const headers = parseHeaders(pgn.split("\n").filter((l) => l.startsWith("[")));
  if (!isUsableGame(headers, history.length)) return [];

  const whiteElo = Number(headers.WhiteElo);
  const blackElo = Number(headers.BlackElo);
  const id = gameId(headers);

  // Sample without replacement from every ply, including the opening. Excluding
  // book moves would flatter the model: they are the most predictable positions
  // in the game, but they are also positions humans really do face, and Maia's
  // odd opening prior (docs/reviews/task-03-maia-review.md) is one of the things
  // a calibration curve can actually say something about.
  const picked = new Set();
  const want = Math.min(opts.pliesPerGame, history.length);
  let guard = 0;
  while (picked.size < want && guard++ < 50) picked.add(Math.floor(rng() * history.length));

  return [...picked].sort((a, b) => a - b).map((ply) => {
    const move = history[ply];
    const whiteToMove = ply % 2 === 0;
    return {
      fen: move.before,
      move: move.lan,
      moverRating: whiteToMove ? whiteElo : blackElo,
      opponentRating: whiteToMove ? blackElo : whiteElo,
      ply,
      game: id,
    };
  });
}

// ── streaming ────────────────────────────────────────────────────────────────

/**
 * Feed PGN lines in, get complete game texts out.
 *
 * The dump is one game after another: a header block, a blank line, the
 * movetext, a blank line. Accumulating until a movetext line has been seen and
 * a blank line follows it is enough to cut games apart without buffering the
 * 28 GB file.
 */
function makeGameSplitter(onGame) {
  let lines = [];
  let sawMoves = false;

  return (line) => {
    const trimmed = line.trimEnd();
    if (trimmed === "") {
      if (sawMoves) {
        onGame(lines.join("\n"));
        lines = [];
        sawMoves = false;
      }
      return;
    }
    if (!trimmed.startsWith("[")) sawMoves = true;
    lines.push(trimmed);
  };
}

/**
 * Drop zstd *skippable* frames from the head of the stream.
 *
 * Not optional, and it fails in the worst possible way without this. The Lichess
 * dumps are written in the seekable-zstd layout, so the file opens with a
 * skippable frame (magic 0x184D2A50-5F, then a little-endian length) before the
 * first real frame. Node's createZstdDecompress does not skip it: fed the file
 * as-is it emits **zero bytes and no error**, which reads exactly like "the month
 * has no rapid games in it" rather than like a decoder problem. Feeding it from
 * byte 12 instead yields PGN immediately - measured on 2026-06, 2 MB in, 14 MB of
 * PGN out.
 */
function stripSkippableFrames() {
  let head = null;
  let passthrough = false;
  let dropping = 0;

  return new Transform({
    transform(chunk, _encoding, callback) {
      if (passthrough) return callback(null, chunk);
      head = head ? Buffer.concat([head, chunk]) : Buffer.from(chunk);

      for (;;) {
        if (dropping > 0) {
          const drop = Math.min(dropping, head.length);
          head = head.subarray(drop);
          dropping -= drop;
          if (dropping > 0) return callback();
        }
        if (head.length < 8) return callback();

        const magic = head.readUInt32LE(0);
        if ((magic & 0xfffffff0) !== 0x184d2a50) {
          // A real zstd frame - hand it over and get out of the way for good.
          passthrough = true;
          const rest = head;
          head = null;
          return callback(null, rest);
        }
        dropping = head.readUInt32LE(4);
        head = head.subarray(8);
      }
    },
  });
}

async function buildFromNetwork() {
  const rng = mulberry32(opts.seed);
  const controller = new AbortController();

  console.log(`source : ${SOURCE_URL}`);
  console.log(`target : ${opts.rows} rows, <=${opts.pliesPerGame} plies/game, seed ${opts.seed}\n`);

  const response = await fetch(SOURCE_URL, { signal: controller.signal });
  if (!response.ok) throw new Error(`lichess responded ${response.status} for ${SOURCE_URL}`);

  await mkdir(dirname(opts.out), { recursive: true });
  const out = createWriteStream(opts.out);

  const stats = { compressedBytes: 0, games: 0, rapid: 0, rows: 0, failed: 0 };
  const spotChecks = [];
  const started = performance.now();
  let done = false;

  // Bytes are counted on the compressed side, before the decompressor, because
  // that is the number that decides when to hang up on a 28 GB download.
  const counted = new Readable({ read() {} });
  const body = Readable.fromWeb(response.body);
  let ended = false;
  const endCounted = () => {
    if (!ended) {
      ended = true;
      counted.push(null);
    }
  };

  body.on("data", (chunk) => {
    stats.compressedBytes += chunk.byteLength;
    counted.push(chunk);
    if (stats.compressedBytes > opts.maxBytes && !done) {
      done = true;
      controller.abort();
    }
  });
  body.on("end", endCounted);

  // Hanging up mid-download makes every stage of the pipe fail: the fetch body
  // with an AbortError, and the decompressor with a truncated frame. Those are
  // the *success* path here, since the stop was deliberate - so each stage
  // records its error instead of throwing, and the run only fails for real if
  // something broke before we had what we came for. Without a listener on each
  // stage, Node turns the very last step of a successful build into a crash.
  let streamError = null;
  const noteError = (err) => {
    if (!done) streamError ??= err;
    endCounted();
  };

  const skipper = stripSkippableFrames();
  const decompressor = createZstdDecompress();
  for (const stage of [body, counted, skipper, decompressor]) stage.on("error", noteError);

  const lines = createInterface({ input: counted.pipe(skipper).pipe(decompressor) });

  const handleGame = (pgn) => {
    if (done) return;
    stats.games++;
    // Cheap header test before the expensive parse: most games in the file are
    // blitz or bullet, and loadPgn on all of them would dominate the runtime.
    if (!/\[Event "[^"]*Rapid/.test(pgn)) return;
    stats.rapid++;

    let rows;
    try {
      rows = rowsFromGame(pgn, rng);
    } catch {
      // A PGN chess.js won't accept is a row we skip, not a run we abort - at
      // this scale there are always a few. Counted so "a few" can be checked.
      stats.failed++;
      return;
    }

    for (const row of rows) {
      if (stats.rows >= opts.rows) break;
      out.write(JSON.stringify(row) + "\n");
      stats.rows++;
      // Keep the source PGN for a handful of rows so verification check 4 can
      // re-derive them from scratch later, against a parser run it didn't see.
      if (spotChecks.length < opts.spotCheck && stats.rows % 137 === 0) {
        spotChecks.push({ row, pgn });
      }
    }

    if (stats.rows >= opts.rows) {
      done = true;
      controller.abort();
    }
  };

  const splitter = makeGameSplitter(handleGame);
  let lastReport = 0;

  try {
    for await (const line of lines) {
      splitter(line);
      if (done) break;
      if (stats.compressedBytes - lastReport > 8_000_000) {
        lastReport = stats.compressedBytes;
        process.stdout.write(
          `\r  ${(stats.compressedBytes / 1e6).toFixed(0)} MB read · ` +
            `${stats.games} games · ${stats.rapid} rapid · ${stats.rows} rows`,
        );
      }
    }
  } catch (err) {
    if (!done) throw err;
  }
  if (streamError) throw streamError;

  process.stdout.write("\r" + " ".repeat(78) + "\r");
  await new Promise((r) => out.end(r));
  await writeFile(SPOT_CHECK_PATH, JSON.stringify(spotChecks, null, 2));

  const seconds = (performance.now() - started) / 1000;
  console.log(`read   : ${(stats.compressedBytes / 1e6).toFixed(1)} MB compressed in ${seconds.toFixed(1)}s`);
  console.log(`games  : ${stats.games} scanned, ${stats.rapid} rapid, ${stats.failed} unparseable`);
  console.log(`rows   : ${stats.rows} -> ${opts.out}`);
  console.log(`spot   : ${spotChecks.length} source PGNs -> ${SPOT_CHECK_PATH}`);

  if (stats.rows < opts.rows) {
    const hitCap = stats.compressedBytes >= opts.maxBytes;
    console.log(
      `\nWARNING: stopped ${opts.rows - stats.rows} rows short of the ${opts.rows} asked for.\n` +
        (hitCap
          ? `  Cause: hit the ${(opts.maxBytes / 1e6).toFixed(0)} MB read cap. Raise --maxBytes.`
          : `  Cause: the decompressed stream ended first - see "one frame only" in the\n` +
            `  header comment. ~14k games is what one frame of a Lichess month yields,\n` +
            `  which is about 4,000 rows at 2 plies/game. More than that needs the\n` +
            `  multi-frame fix, not a bigger --maxBytes.`),
    );
  }
}

// ── selftest ─────────────────────────────────────────────────────────────────
// Runs the exact extraction path the real build uses against a PGN whose answer
// is known by hand, so a chess.js API change (or a bad edit here) fails in two
// seconds without touching the network.

const SELFTEST_PGN = `[Event "Rated Rapid game"]
[Site "https://lichess.org/selftest"]
[White "alice"]
[Black "bob"]
[Result "0-1"]
[WhiteElo "1486"]
[BlackElo "1523"]
[TimeControl "600+0"]

1. e4 { [%clk 0:10:00] } 1... c5 { [%clk 0:10:00] } 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6
5. Nc3 a6 6. Be3 e5 7. Nb3 Be6 8. f3 Be7 9. Qd2 O-O 10. O-O-O Nbd7 0-1`;

function selftest() {
  const chess = new Chess();
  chess.loadPgn(SELFTEST_PGN);
  const history = chess.history({ verbose: true });

  const checks = [];
  const check = (label, got, want) =>
    checks.push({ label, ok: String(got) === String(want), got, want });

  check("ply count", history.length, 20);
  check("ply 0 before-FEN", history[0].before, new Chess().fen());
  check("ply 0 lan", history[0].lan, "e2e4");
  check("ply 1 lan (black's reply)", history[1].lan, "c7c5");
  check(
    "ply 1 before-FEN is after white's e4",
    history[1].before,
    "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
  );
  check("ply 18 is castling, encoded as king move", history[18].lan, "e1c1");

  // Pin chess.js's en-passant convention in both directions, because plane 17 of
  // boardToTensor reads this field straight off the FEN. chess.js emits the EP
  // square only when a capture is actually available; python-chess set it after
  // any double push while Maia was trained. docs/reviews/task-03-maia-review.md
  // Q3 established that the capturable case - the one that matters - encodes
  // canonically, so the rows this script emits inherit that. If chess.js ever
  // flipped to the other convention, these two checks are what would notice.
  const epBoard = new Chess();
  epBoard.loadPgn(`[Event "Rated Rapid game"]\n\n1. e4 e6 2. e5 d5 *`);
  const epHistory = epBoard.history({ verbose: true });
  check(
    "EP square present when the capture is legal",
    epHistory[3].after.split(" ")[3],
    "d6",
  );
  check("EP square omitted when no capture is legal", history[1].before.split(" ")[3], "-");

  // Every row's FEN must be a position where its move is legal, and the mover's
  // rating must be the side actually to move - the two things a ply-index slip
  // would break.
  const rows = rowsFromGame(SELFTEST_PGN, mulberry32(1));
  check("rows produced", rows.length, 2);
  for (const row of rows) {
    const board = new Chess(row.fen);
    const legal = board
      .moves({ verbose: true })
      .some((m) => `${m.from}${m.to}${m.promotion ?? ""}` === row.move);
    check(`ply ${row.ply}: stored move is legal at stored FEN`, legal, true);
    const whiteToMove = row.fen.split(" ")[1] === "w";
    check(`ply ${row.ply}: mover rating matches side to move`, row.moverRating, whiteToMove ? 1486 : 1523);
    check(`ply ${row.ply}: ply parity matches side to move`, row.ply % 2 === 0, whiteToMove);
  }

  // A blitz game must not survive the filter, or the whole corpus is wrong.
  check(
    "blitz game rejected",
    rowsFromGame(SELFTEST_PGN.replace("Rated Rapid game", "Rated Blitz game"), mulberry32(1)).length,
    0,
  );

  for (const { label, ok, got, want } of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        got  ${got}\n        want ${want}`}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
}

if (opts.selftest) selftest();
else await buildFromNetwork();
