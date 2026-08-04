import { Chess } from "chess.js";
import * as ort from "onnxruntime-web";

import type { EngineConfig, EngineMove } from "./types";

// Maia 2 ("rapid"), MIT-licensed, run via onnxruntime-web.
//
// Not the Maia the build plan described. That one is lc0-format .pb.gz weights
// needing an lc0 binary and `leela2onnx`, with 112 input planes including move
// history. This is the newer unified model: already ONNX, no lc0, no conversion,
// no history planes, and the player rating is a model *input* rather than one
// network per tier. See scripts/maia-notes.md for the full comparison.
//
// Neither the weights nor the move table are committed to this repo. Both are
// fetched at runtime from GitHub raw (which serves Access-Control-Allow-Origin:
// *). That keeps ~89MB of third-party artefacts out of the repo and off our
// Vercel bandwidth - the same reason CSSLab moved these files off their own
// hosting.
const MODEL_URL =
  "https://raw.githubusercontent.com/CSSLab/maia-platform-frontend/e23a50e/public/maia2/maia_rapid.onnx";

// The move index the policy head is ordered by, pinned to the SAME commit as the
// model so the two can't drift apart. The file has since moved twice upstream
// (hooks/ -> providers/ -> lib/), but both moves were pure renames: the blob SHA
// at this commit and on main are identical, verified. The reversed direction is
// derived by inversion rather than fetched separately.
const MOVE_TABLE_URL =
  "https://raw.githubusercontent.com/CSSLab/maia-platform-frontend/e23a50e/src/hooks/useMaiaEngine/data/all_moves.json";

/** Rating buckets the model was trained with: <1100, then 100-wide, then >=2000. */
const ELO_MIN = 1100;
const ELO_MAX = 2000;
const ELO_STEP = 100;

let session: ort.InferenceSession | null = null;
let moveTable: Record<string, number> | null = null;
let moveTableReversed: string[] | null = null;
let loading: Promise<void> | null = null;

// ── FEN mirroring ────────────────────────────────────────────────────────────
// The model always sees the position from the mover's side, so a black-to-move
// FEN is flipped vertically and colour-swapped before encoding, and the chosen
// move is flipped back afterwards.

function mirrorSquare(square: string): string {
  return square[0] + (9 - Number(square[1])).toString();
}

export function mirrorMove(uci: string): string {
  const promotion = uci.length > 4 ? uci.slice(4) : "";
  return mirrorSquare(uci.slice(0, 2)) + mirrorSquare(uci.slice(2, 4)) + promotion;
}

function swapColorsInRank(rank: string): string {
  let out = "";
  for (const ch of rank) {
    if (/[A-Z]/.test(ch)) out += ch.toLowerCase();
    else if (/[a-z]/.test(ch)) out += ch.toUpperCase();
    else out += ch;
  }
  return out;
}

function swapCastlingRights(castling: string): string {
  if (castling === "-") return "-";
  const has = (c: string) => castling.includes(c);
  // White rights become black rights and vice versa, re-emitted in KQkq order.
  let out = "";
  if (has("k")) out += "K";
  if (has("q")) out += "Q";
  if (has("K")) out += "k";
  if (has("Q")) out += "q";
  return out === "" ? "-" : out;
}

export function mirrorFen(fen: string): string {
  const [position, active, castling, enPassant, halfmove, fullmove] = fen.split(" ");
  const mirroredPosition = position
    .split("/")
    .reverse()
    .map(swapColorsInRank)
    .join("/");

  return [
    mirroredPosition,
    active === "w" ? "b" : "w",
    swapCastlingRights(castling),
    enPassant !== "-" ? mirrorSquare(enPassant) : "-",
    halfmove,
    fullmove,
  ].join(" ");
}

// ── Encoding ─────────────────────────────────────────────────────────────────

const PIECE_ORDER = ["P", "N", "B", "R", "Q", "K", "p", "n", "b", "r", "q", "k"];

/**
 * 18 planes of 8x8: 12 piece planes, side-to-move, 4 castling rights, en passant.
 * Note this is richer than Maia 3's input, which encodes piece placement only and
 * therefore cannot see castling availability at all.
 */
export function boardToTensor(fen: string): Float32Array {
  const [placement, active, castling, enPassant] = fen.split(" ");
  const tensor = new Float32Array(18 * 64);

  const ranks = placement.split("/");
  for (let rank = 0; rank < 8; rank++) {
    const row = 7 - rank; // FEN lists rank 8 first
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

  // Side to move (plane 12) is uniform across the plane.
  tensor.fill(active === "w" ? 1 : 0, 12 * 64, 13 * 64);

  // Castling rights (planes 13-16), each uniform if the right exists.
  ["K", "Q", "k", "q"].forEach((right, i) => {
    if (castling.includes(right)) tensor.fill(1, (13 + i) * 64, (14 + i) * 64);
  });

  // En passant target (plane 17), a single square.
  if (enPassant !== "-") {
    const file = enPassant.charCodeAt(0) - "a".charCodeAt(0);
    const rank = Number.parseInt(enPassant[1], 10) - 1;
    tensor[17 * 64 + rank * 8 + file] = 1;
  }

  return tensor;
}

/** Rating -> bucket index. 0 is "below 1100", the last is "2000 and up". */
export function eloToCategory(elo: number): number {
  if (elo < ELO_MIN) return 0;
  if (elo >= ELO_MAX) return (ELO_MAX - ELO_MIN) / ELO_STEP + 1;
  return Math.floor((elo - ELO_MIN) / ELO_STEP) + 1;
}

// ── Loading ──────────────────────────────────────────────────────────────────

async function load(): Promise<void> {
  if (loading) return loading;

  loading = (async () => {
    if (typeof window === "undefined") {
      throw new Error("Maia runs in the browser only");
    }

    // Single-threaded on purpose: threads need SharedArrayBuffer, which needs
    // COOP/COEP headers. The spec deliberately avoids those (same reason we use
    // single-threaded Stockfish), so numThreads stays at 1.
    ort.env.wasm.wasmPaths = "/ort/";
    ort.env.wasm.numThreads = 1;

    const [modelResponse, tableResponse] = await Promise.all([
      fetch(MODEL_URL),
      fetch(MOVE_TABLE_URL),
    ]);
    if (!modelResponse.ok) throw new Error(`Maia model fetch failed: ${modelResponse.status}`);
    if (!tableResponse.ok) throw new Error(`Maia move table fetch failed: ${tableResponse.status}`);

    const [modelBuffer, table] = await Promise.all([
      modelResponse.arrayBuffer(),
      tableResponse.json() as Promise<Record<string, number>>,
    ]);

    moveTable = table;
    moveTableReversed = [];
    for (const [uci, index] of Object.entries(table)) moveTableReversed[index] = uci;

    session = await ort.InferenceSession.create(modelBuffer);
  })();

  loading.catch(() => {
    loading = null; // let a failed load be retried
  });

  return loading;
}

export interface MaiaEvaluation {
  /** Legal moves in real board coordinates, best first, with probabilities. */
  policy: { uci: string; probability: number }[];
  /** Raw scalar from the value head, reported untransformed. */
  value: number;
  /** Names the ONNX graph actually exposes - used by the verification page. */
  inputNames: string[];
  outputNames: string[];
}

/**
 * Full policy and value for a position. Exported mainly so the verification page
 * can check that the rating input actually changes the output.
 */
export async function evaluateMaia(
  fen: string,
  config: EngineConfig
): Promise<MaiaEvaluation> {
  await load();
  if (!session || !moveTable || !moveTableReversed) {
    throw new Error("Maia not available");
  }

  const blackToMove = fen.split(" ")[1] === "b";
  const encodedFen = blackToMove ? mirrorFen(fen) : fen;

  // Legal moves come from the mirrored board, because the policy indices do too.
  const board = new Chess(encodedFen);
  const legalIndices: number[] = [];
  for (const move of board.moves({ verbose: true })) {
    const index = moveTable[`${move.from}${move.to}${move.promotion ?? ""}`];
    if (index !== undefined) legalIndices.push(index);
  }

  const rating = config.ratingTier ?? 1500;
  const category = BigInt(eloToCategory(rating));

  const outputs = await session.run({
    boards: new ort.Tensor("float32", boardToTensor(encodedFen), [1, 18, 8, 8]),
    elo_self: new ort.Tensor("int64", BigInt64Array.from([category])),
    elo_oppo: new ort.Tensor("int64", BigInt64Array.from([category])),
  });

  const logits = outputs.logits_maia.data as Float32Array;
  const value = Number((outputs.logits_value.data as Float32Array)[0]);

  // Softmax over legal moves only.
  const legalLogits = legalIndices.map((i) => logits[i]);
  const max = Math.max(...legalLogits);
  const exp = legalLogits.map((l) => Math.exp(l - max));
  const sum = exp.reduce((a, b) => a + b, 0);

  const policy = legalIndices
    .map((index, i) => {
      const uci = moveTableReversed![index];
      return {
        uci: blackToMove ? mirrorMove(uci) : uci,
        probability: exp[i] / sum,
      };
    })
    .sort((a, b) => b.probability - a.probability);

  return {
    policy,
    value,
    inputNames: [...session.inputNames],
    outputNames: [...session.outputNames],
  };
}

/**
 * Same contract as getStockfishMove. Maia is a policy network trained to imitate
 * human play, so the move is simply its highest-probability legal move - no
 * search on top, which would defeat the point of using it.
 */
export async function getMaiaMove(
  fen: string,
  config: EngineConfig
): Promise<EngineMove> {
  const { policy } = await evaluateMaia(fen, config);
  if (policy.length === 0) throw new Error("Maia returned no legal move");

  const best = policy[0].uci;
  return {
    from: best.slice(0, 2),
    to: best.slice(2, 4),
    promotion: best.length > 4 ? best.slice(4, 5) : undefined,
  };
}
