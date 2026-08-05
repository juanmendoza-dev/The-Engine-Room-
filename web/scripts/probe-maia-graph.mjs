// What maia_rapid.onnx actually does, answered in Node instead of a browser.
//
// Two questions the rollouts spec
// (docs/specs/2026-08-05-maia-monte-carlo-rollouts.md) calls out as unverified:
//
//  1. Is the graph's batch axis dynamic, or was it exported hardcoded to 1? The
//     spec calls this its "single biggest unknown" and says to answer it before
//     writing anything downstream. Also: is the output really row-major [N,V]?
//  2. logits_value has the right *sign* but no established transform to a win
//     probability, so truncated rollouts get bootstrapped off a squashing
//     function whose constants are a guess. This measures the range that guess
//     has to cover instead of inventing one.
//
// Runs under Node - onnxruntime-web's wasm backend works fine outside a browser
// - so it answers both without the 93MB download the browser pays every load.
// The encoder below is a deliberate copy of boardToTensor/mirrorFen's layout,
// not an import: the real ones are TS behind a browser-only module guard, and
// duplicating ~40 lines of plane packing here is cheaper than a build step. It
// is checked against the real thing rather than trusted: the start-position
// value printed below matches docs/maia-notes.md's -0.1813 to four decimals,
// which it could not do if these planes were packed differently.
//
// usage: node scripts/probe-maia-graph.mjs <path-to-maia_rapid.onnx>
//
// Get the model with (into any directory OUTSIDE the repo - 93MB, never commit it):
//   curl -sL -o /tmp/maia_rapid.onnx \
//     https://raw.githubusercontent.com/juanmendoza-dev/engine-room-assets/7c916f4d794ff411ffe6d0be85c8b1c75e61c8fe/maia2/maia_rapid.onnx

import { readFile } from "node:fs/promises";
import * as ort from "onnxruntime-web";

const MODEL_PATH = process.argv[2];
if (!MODEL_PATH) throw new Error("pass the path to maia_rapid.onnx");

const PIECE_ORDER = ["P", "N", "B", "R", "Q", "K", "p", "n", "b", "r", "q", "k"];

function boardToTensor(fen) {
  const [placement, active, castling, enPassant] = fen.split(" ");
  const tensor = new Float32Array(18 * 64);
  const ranks = placement.split("/");
  for (let rank = 0; rank < 8; rank++) {
    const row = 7 - rank;
    let file = 0;
    for (const ch of ranks[rank]) {
      const empty = Number.parseInt(ch, 10);
      if (Number.isNaN(empty)) {
        const piece = PIECE_ORDER.indexOf(ch);
        if (piece >= 0) tensor[piece * 64 + row * 8 + file] = 1;
        file += 1;
      } else {
        file += empty;
      }
    }
  }
  tensor.fill(active === "w" ? 1 : 0, 12 * 64, 13 * 64);
  ["K", "Q", "k", "q"].forEach((right, i) => {
    if (castling.includes(right)) tensor.fill(1, (13 + i) * 64, (14 + i) * 64);
  });
  if (enPassant !== "-") {
    const file = enPassant.charCodeAt(0) - "a".charCodeAt(0);
    const rank = Number.parseInt(enPassant[1], 10) - 1;
    tensor[17 * 64 + rank * 8 + file] = 1;
  }
  return tensor;
}

// The model always sees the position from the mover's side, so a black-to-move
// FEN is flipped and colour-swapped first. Same as engineMaia.ts's mirrorFen.
function mirrorFen(fen) {
  const [position, active, castling, enPassant, halfmove, fullmove] = fen.split(" ");
  const swapCase = (s) =>
    [...s]
      .map((c) => (/[A-Z]/.test(c) ? c.toLowerCase() : /[a-z]/.test(c) ? c.toUpperCase() : c))
      .join("");
  const mirrorSquare = (sq) => sq[0] + (9 - Number(sq[1])).toString();
  let rights = "";
  if (castling.includes("k")) rights += "K";
  if (castling.includes("q")) rights += "Q";
  if (castling.includes("K")) rights += "k";
  if (castling.includes("Q")) rights += "q";
  return [
    position.split("/").reverse().map(swapCase).join("/"),
    active === "w" ? "b" : "w",
    castling === "-" ? "-" : rights || "-",
    enPassant !== "-" ? mirrorSquare(enPassant) : "-",
    halfmove,
    fullmove,
  ].join(" ");
}

const encode = (fen) => boardToTensor(fen.split(" ")[1] === "b" ? mirrorFen(fen) : fen);

const FEN_A = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const FEN_B = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";
const CATEGORY = 5; // eloToCategory(1500)

ort.env.wasm.numThreads = 1;
ort.env.logLevel = "error";

const model = new Uint8Array(await readFile(MODEL_PATH));
console.log(`model: ${model.byteLength} bytes`);

const session = await ort.InferenceSession.create(model);
console.log("inputs :", session.inputNames.join(", "));
console.log("outputs:", session.outputNames.join(", "));
if (session.inputMetadata) console.log("declared shapes:", JSON.stringify(session.inputMetadata));

/** rows: [{ fen, self?, oppo? }] -> raw outputs for the whole batch in one pass. */
async function run(rows) {
  const n = rows.length;
  const boards = new Float32Array(n * 18 * 64);
  rows.forEach((row, i) => boards.set(encode(row.fen), i * 18 * 64));
  const feeds = {
    boards: new ort.Tensor("float32", boards, [n, 18, 8, 8]),
    elo_self: new ort.Tensor("int64", BigInt64Array.from(rows.map((r) => BigInt(r.self ?? CATEGORY)))),
    elo_oppo: new ort.Tensor("int64", BigInt64Array.from(rows.map((r) => BigInt(r.oppo ?? CATEGORY)))),
  };
  const t0 = performance.now();
  const out = await session.run(feeds);
  return { out, ms: performance.now() - t0 };
}

// ── 1. batch axis + row layout ───────────────────────────────────────────────
console.log("\n== batch axis and row layout ==");
const a1 = await run([{ fen: FEN_A }]);
const b1 = await run([{ fen: FEN_B }]);
const V = a1.out.logits_maia.dims.at(-1);
console.log(
  `N=1  logits_maia ${JSON.stringify(a1.out.logits_maia.dims)}` +
    `  logits_value ${JSON.stringify(a1.out.logits_value.dims)}  (V=${V})`,
);

let batch;
try {
  batch = await run([{ fen: FEN_A }, { fen: FEN_B }]);
} catch (err) {
  console.log("=== BATCH AXIS IS NOT DYNAMIC ===");
  console.log(String(err?.message ?? err));
  console.log("done");
  process.exit(1);
}
console.log(
  `N=2  logits_maia ${JSON.stringify(batch.out.logits_maia.dims)}` +
    `  logits_value ${JSON.stringify(batch.out.logits_value.dims)}`,
);

const maxDiff = (x, y) => {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - y[i]));
  return m;
};
const rowA = batch.out.logits_maia.data.subarray(0, V);
const rowB = batch.out.logits_maia.data.subarray(V, 2 * V);
const diffAA = maxDiff(rowA, a1.out.logits_maia.data);
const diffBB = maxDiff(rowB, b1.out.logits_maia.data);
const diffAB = maxDiff(rowA, b1.out.logits_maia.data);
console.log(`row0 vs A alone: ${diffAA.toExponential(3)}   row1 vs B alone: ${diffBB.toExponential(3)}`);
console.log(`row0 vs B alone: ${diffAB.toExponential(3)}  <- wants to be LARGE, or rows are duplicated/transposed`);
const aligned = diffAA < 1e-3 && diffBB < 1e-3 && diffAB > 1e-2;
console.log(`${aligned ? "PASS" : "FAIL"}  batch axis dynamic, rows row-major [N,V] and aligned`);

// ── 2. does batching actually buy throughput? ────────────────────────────────
// The spec budgets against a floor of "no raw-compute win from batching" and
// treats anything better as upside. This measures which one is true.
console.log("\n== throughput vs the spec's floor ==");
for (const n of [1, 9, 30, 100]) {
  const rows = Array.from({ length: n }, (_, i) => ({ fen: i % 2 ? FEN_B : FEN_A }));
  const warm = await run(rows);
  const timed = await run(rows);
  const ms = Math.min(warm.ms, timed.ms);
  console.log(
    `N=${String(n).padEnd(4)} ${ms.toFixed(0).padStart(6)}ms/pass  ` +
      `${(ms / n).toFixed(1).padStart(5)}ms/position`,
  );
}

// ── 3. the value head's observed range ──────────────────────────────────────
// Always from the side to move's point of view, since positions are mirrored
// before encoding exactly as engineMaia.ts does it.
console.log("\n== logits_value range (mover's perspective) ==");
const VALUE_FENS = [
  ["start position (even)", FEN_A],
  ["mover up a queen", "rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"],
  ["mover down a queen", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1"],
  ["mover has mate in 1 (Ra8#)", "6k1/5ppp/8/8/8/8/8/R6K w - - 0 1"],
  ["mover gets mated next (same, black)", "6k1/5ppp/8/8/8/8/8/R6K b - - 0 1"],
  ["mover up rook + queen", "1nb1kbn1/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQ - 0 1"],
  ["mover down rook + queen", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/1NB1KBN1 w kq - 0 1"],
  ["dead drawn K v K", "8/8/4k3/8/8/4K3/8/8 w - - 0 1"],
  ["winning K+P v K", "8/8/8/3k4/8/8/4P3/4K3 w - - 0 1"],
  ["black to move, up a queen", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR b KQkq - 0 1"],
];
const values = [];
for (const [label, fen] of VALUE_FENS) {
  const { out } = await run([{ fen }]);
  const v = Number(out.logits_value.data[0]);
  values.push(v);
  console.log(`${v >= 0 ? "+" : ""}${v.toFixed(4)}  ${label}`);
}
console.log(`observed span: ${Math.min(...values).toFixed(4)} .. ${Math.max(...values).toFixed(4)}`);

// Does the rating input move the value at all? Matters because a rollout feeds
// elo_self/elo_oppo per side and a bootstrapped truncation reads this scalar.
//
// Read the two sweeps together, in this order - the first one on its own is
// misleading. MISMATCHED (elo_oppo pinned at 1500) is a rating *gap*: a cat-1
// player facing 1500 really is worse off, so a value sliding with elo_self there
// is the model pricing the gap, not drifting. MATCHED is the one that isolates
// rating from mismatch, and it's the number a rollout's truncation centre needs,
// because a rollout at one tier feeds the same category to both inputs.
console.log("\n== value vs elo_self, opponent PINNED at 1500 (a rating gap) ==");
const cats = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const mismatched = await run(cats.map((self) => ({ fen: FEN_B, self, oppo: CATEGORY })));
console.log(
  cats.map((c, i) => `${c}:${Number(mismatched.out.logits_value.data[i]).toFixed(3)}`).join("  "),
);

console.log("\n== value vs elo_self, opponent MATCHED (no gap) ==");
// Four positions that are objectively about level, so whatever is left is the
// model's own idea of "an even game at this rating" - the centre a truncated
// rollout has to be squashed around.
const BALANCED = [
  ["start position", FEN_A],
  ["mid-opening", FEN_B],
  ["symmetrical exchange", "r1bqk2r/pppp1ppp/2n2n2/4p3/4P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 5"],
  ["level rook endgame", "5rk1/5ppp/8/8/8/8/5PPP/5RK1 w - - 0 1"],
];
const matchedRows = [];
for (const [, fen] of BALANCED) for (const c of cats) matchedRows.push({ fen, self: c, oppo: c });
const matched = await run(matchedRows);
const byCategory = cats.map(() => []);
matchedRows.forEach((row, i) => {
  byCategory[cats.indexOf(row.self)].push(Number(matched.out.logits_value.data[i]));
});
BALANCED.forEach(([label], p) => {
  console.log(
    `${label.padEnd(22)} ` +
      cats.map((c, i) => `${c}:${byCategory[i][p].toFixed(3)}`).join("  "),
  );
});
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log(
  "mean per category:     " + cats.map((c, i) => `${c}:${mean(byCategory[i]).toFixed(3)}`).join("  "),
);
const allMatched = byCategory.flat();
console.log(
  `all matched-tier balanced positions: mean ${mean(allMatched).toFixed(4)}, ` +
    `span ${Math.min(...allMatched).toFixed(4)} .. ${Math.max(...allMatched).toFixed(4)}`,
);

console.log("\ndone");
