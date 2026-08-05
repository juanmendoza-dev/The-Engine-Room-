import { Chess } from "chess.js";
import * as ort from "onnxruntime-web";

import type { EngineConfig, EngineMove } from "./types";

// Maia 2 ("rapid"), MIT-licensed, run via onnxruntime-web.
//
// Not the Maia the build plan described. That one is lc0-format .pb.gz weights
// needing an lc0 binary and `leela2onnx`, with 112 input planes including move
// history. This is the newer unified model: already ONNX, no lc0, no conversion,
// no history planes, and the player rating is a model *input* rather than one
// network per tier. See docs/maia-notes.md for the full comparison.
//
// Neither the weights nor the move table are committed to this repo. Both are
// fetched at runtime from GitHub raw (which serves Access-Control-Allow-Origin:
// *). That keeps ~93MB of artefacts out of this repo and the per-load egress off
// our Vercel bandwidth - the same reason CSSLab moved these files off their own
// hosting.
//
// They come from juanmendoza-dev/engine-room-assets, our own mirror, pinned to
// one commit. Two reasons it isn't CSSLab's copy any more:
//
//  - CSSLab have deleted maia_rapid.onnx from their main branch (they ship
//    public/maia3/ now), so their commit e23a50e was the only thing still
//    serving it: a single point of failure on the demo path, outside our
//    control.
//  - Both files are pinned to the SAME commit of the SAME repo, which is what
//    stops the weights and the move index drifting apart. Mismatch there
//    wouldn't error, it would silently decode the wrong move.
//
// Mirrored byte-for-byte (sha256 round-trip verified through raw). MIT, (c) 2024
// CSSLab; notice reproduced in that repo. NOT a GitHub Release, deliberately -
// release assets come off an Azure blob with no CORS headers at all, so a
// browser fetch of one fails outright. Checked in a real browser, both ways.
const ASSET_BASE =
  "https://raw.githubusercontent.com/juanmendoza-dev/engine-room-assets/7c916f4d794ff411ffe6d0be85c8b1c75e61c8fe/maia2";

const MODEL_URL = `${ASSET_BASE}/maia_rapid.onnx`;

/** Move index the policy head is ordered by. Reversed direction is derived by
 * inversion rather than fetched separately. */
const MOVE_TABLE_URL = `${ASSET_BASE}/all_moves.json`;

/** Rating buckets the model was trained with: <1100, then 100-wide, then >=2000. */
const ELO_MIN = 1100;
const ELO_MAX = 2000;
const ELO_STEP = 100;

/**
 * Rough download size, for the "this will take a moment" notice shown before the
 * real Content-Length arrives. Decimal MB, to match the progress readout - the
 * measured body is 93,246,338 bytes, which is 93MB decimal and the 89MiB the
 * docs call "~89MB". Keep both numbers in the UI in the same unit or the notice
 * contradicts the progress bar directly under it.
 */
export const MAIA_MODEL_SIZE_MB = 93;

/**
 * Abort if the download makes no progress at all for this long.
 *
 * Deliberately a *stall* timeout rather than a total one. A total budget can't
 * work here: 89MB is ~25s on a fast line but a legitimate ~2.5 minutes on
 * 5 Mbit/s conference wifi, so any cap generous enough for the slow case is too
 * long to be useful in the stalled case. Measuring silence instead catches the
 * failure we actually care about - a fetch that hangs forever and leaves a
 * permanent "thinking" lamp on the board - without punishing slow-but-working
 * connections.
 */
const STALL_TIMEOUT_MS = 20_000;

/** Report progress at most once per this many bytes, to bound re-renders. */
const PROGRESS_INTERVAL_BYTES = 1_000_000;

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

/** Floats in one position's input planes — the stride between batch rows. */
const PLANE_FLOATS = 18 * 64;

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

// ── Load state, published so the UI can explain the wait ─────────────────────
// The model is ~89MB fetched at runtime, and Chrome refuses to disk-cache a body
// that large, so *every* full page load pays the download again. Without this,
// picking Maia means staring at a frozen board under a "thinking" lamp for 25s+
// with nothing to distinguish it from a hang.

export type MaiaLoadStatus = "idle" | "downloading" | "initializing" | "ready" | "failed";

export interface MaiaLoadState {
  status: MaiaLoadStatus;
  /** Bytes of the model body received so far. */
  receivedBytes: number;
  /** Content-Length, when the server sends one. */
  totalBytes: number | null;
  error: string | null;
}

const IDLE_STATE: MaiaLoadState = {
  status: "idle",
  receivedBytes: 0,
  totalBytes: null,
  error: null,
};

let loadState: MaiaLoadState = IDLE_STATE;
const loadListeners = new Set<() => void>();

/**
 * Current load state. A stable reference between changes, so it can be handed
 * straight to `useSyncExternalStore` as the snapshot.
 */
export function getMaiaLoadState(): MaiaLoadState {
  return loadState;
}

export function subscribeMaiaLoad(listener: () => void): () => void {
  loadListeners.add(listener);
  return () => loadListeners.delete(listener);
}

function setLoadState(patch: Partial<MaiaLoadState>): void {
  loadState = { ...loadState, ...patch };
  for (const listener of loadListeners) listener();
}

// ── Loading ──────────────────────────────────────────────────────────────────

/**
 * Fetch with byte progress and a stall timeout. Streams the body rather than
 * awaiting `arrayBuffer()` so there's something to report during the ~25s the
 * model takes, and so a silent connection can be distinguished from a slow one.
 */
async function fetchModel(): Promise<Uint8Array> {
  const controller = new AbortController();
  let stalled = false;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;

  const armStallTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, STALL_TIMEOUT_MS);
  };

  armStallTimer();
  try {
    const response = await fetch(MODEL_URL, { signal: controller.signal });
    if (!response.ok) throw new Error(`Maia model fetch failed: ${response.status}`);

    const header = response.headers.get("content-length");
    const totalBytes = header ? Number(header) : null;
    setLoadState({ status: "downloading", receivedBytes: 0, totalBytes });

    // No streaming body (very old browser): fall back to a plain buffered read.
    // The stall timer still covers a connection that dies mid-transfer.
    if (!response.body) {
      const buffered = new Uint8Array(await response.arrayBuffer());
      setLoadState({ receivedBytes: buffered.byteLength });
      return buffered;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    let reported = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      received += value.byteLength;
      armStallTimer();

      if (received - reported >= PROGRESS_INTERVAL_BYTES) {
        reported = received;
        setLoadState({ receivedBytes: received });
      }
    }

    const model = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      model.set(chunk, offset);
      offset += chunk.byteLength;
    }
    setLoadState({ receivedBytes: received });
    return model;
  } catch (err) {
    if (stalled) {
      throw new Error(
        `Maia model download stalled (no data for ${STALL_TIMEOUT_MS / 1000}s). Check your connection and refresh.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(stallTimer);
  }
}

async function fetchMoveTable(): Promise<Record<string, number>> {
  // 25KB - no progress worth reporting, but it still needs a timeout so a hung
  // request can't leave the load pending forever.
  const response = await fetch(MOVE_TABLE_URL, {
    signal: AbortSignal.timeout(STALL_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Maia move table fetch failed: ${response.status}`);
  return (await response.json()) as Record<string, number>;
}

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

    setLoadState({ status: "downloading", receivedBytes: 0, totalBytes: null, error: null });

    const [model, table] = await Promise.all([fetchModel(), fetchMoveTable()]);

    moveTable = table;
    moveTableReversed = [];
    for (const [uci, index] of Object.entries(table)) moveTableReversed[index] = uci;

    // Session creation is another ~2-3s of wasm compile on top of the download,
    // and it's silent, so it gets its own status rather than looking like a hang
    // right at the point the progress bar fills.
    setLoadState({ status: "initializing" });
    session = await ort.InferenceSession.create(model);

    setLoadState({ status: "ready" });
  })();

  loading.catch((err: unknown) => {
    loading = null; // let a failed load be retried
    setLoadState({
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
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

// ── One session, one caller at a time ────────────────────────────────────────
// ORT throws `Session already started` if two session.run() calls overlap on the
// same InferenceSession. Measured, not assumed: it showed up the moment a page
// with two concurrent evaluate calls loaded under React StrictMode's double
// invocation, and it answers a question the rating-inference spec left open
// ("whether concurrent session.run() calls on one session even interleave safely
// is unverified") with a flat no.
//
// It matters because there is now a second caller. The game loop on its own is
// strictly sequential, so nothing collided before; the rating estimator fires
// nine passes off the move-response path, which lands them squarely on top of
// the opponent's own getMaiaMove. Whichever call lost that race would throw, and
// if the loser were the opponent's, /user-1v1 would show "Engine failed" for a
// reason nothing in the game code could explain.
//
// Serialising here rather than in the estimator is deliberate: this is the one
// place both callers pass through. It changes nothing for a sequential caller
// beyond a microtask hop - same feeds, same session, byte-identical output - it
// just makes an overlapping call wait its turn instead of failing.
let inferenceQueue: Promise<unknown> = Promise.resolve();

function runExclusive<T>(work: () => Promise<T>): Promise<T> {
  // Same callback on both branches so one caller's failure doesn't strand the
  // queue, and the tail is caught so a rejection can't poison later turns.
  const result = inferenceQueue.then(work, work);
  inferenceQueue = result.catch(() => {});
  return result;
}

// ── Decode, shared by the single-position and batched paths ──────────────────
// Both halves below were inline in evaluateMaiaAt and were lifted out unchanged
// so the batched path can reuse them per row. A pure extraction on purpose: the
// gameplay path's output stays byte-identical, which is the whole reason
// getMaiaMove needed no attention when batching landed.
//
// Both are exported for a third caller that is not in the app at all:
// web/scripts/lib/maiaNode.mjs, the offline calibration audit, which runs this
// same model under plain Node. It cannot call evaluateMaiaAt - that goes through
// load(), which throws outside a browser by design - so it drives the session
// itself and reuses these two for the parts that decide what the numbers *mean*.
// The alternative was a second copy of the legal-move lookup and the softmax, and
// this codebase has already paid once for two encoders quietly disagreeing
// (docs/reviews/task-03-maia-review.md, Q3). Nothing else changes: no call site
// moves, no behaviour differs, these are pure functions either way.

/**
 * Policy-table indices of the legal moves at an **already-mirrored** FEN.
 *
 * Mirrored, because the policy indices are: the model only ever sees a
 * white-to-move board. A legal move missing from the table is skipped rather
 * than defaulted — better to leave it unscored than to score the wrong move.
 */
export function legalPolicyIndices(encodedFen: string, table: Record<string, number>): number[] {
  const board = new Chess(encodedFen);
  const indices: number[] = [];
  for (const move of board.moves({ verbose: true })) {
    const index = table[`${move.from}${move.to}${move.promotion ?? ""}`];
    if (index !== undefined) indices.push(index);
  }
  return indices;
}

/** Softmax over the legal moves only, back in real board coordinates, best first. */
export function decodePolicy(
  rowLogits: Float32Array,
  legalIndices: number[],
  blackToMove: boolean,
  reversed: string[],
): MaiaEvaluation["policy"] {
  const legalLogits = legalIndices.map((i) => rowLogits[i]);
  const max = Math.max(...legalLogits);
  const exp = legalLogits.map((l) => Math.exp(l - max));
  const sum = exp.reduce((a, b) => a + b, 0);

  return legalIndices
    .map((index, i) => ({
      uci: blackToMove ? mirrorMove(reversed[index]) : reversed[index],
      probability: exp[i] / sum,
    }))
    .sort((a, b) => b.probability - a.probability);
}

interface MaiaRowRequest {
  fen: string;
  selfCategory: number;
  oppoCategory: number;
}

/**
 * The one place a `session.run()` happens. Everything public in this module is a
 * wrapper over this, so there's a single copy of the tensor shapes, the
 * mirroring, and the ORT serialisation to get wrong.
 */
async function evaluateMaiaRows(requests: MaiaRowRequest[]): Promise<MaiaEvaluation[]> {
  await load();
  if (!session || !moveTable || !moveTableReversed) {
    throw new Error("Maia not available");
  }
  if (requests.length === 0) return [];

  const active = session;
  const table = moveTable;
  const reversed = moveTableReversed;
  const n = requests.length;

  const boards = new Float32Array(n * PLANE_FLOATS);
  const selfCategories = new BigInt64Array(n);
  const oppoCategories = new BigInt64Array(n);

  const decoders = requests.map((request, i) => {
    const blackToMove = request.fen.split(" ")[1] === "b";
    const encodedFen = blackToMove ? mirrorFen(request.fen) : request.fen;
    boards.set(boardToTensor(encodedFen), i * PLANE_FLOATS);
    selfCategories[i] = BigInt(request.selfCategory);
    oppoCategories[i] = BigInt(request.oppoCategory);
    return { blackToMove, legalIndices: legalPolicyIndices(encodedFen, table) };
  });

  const feeds = {
    boards: new ort.Tensor("float32", boards, [n, 18, 8, 8]),
    elo_self: new ort.Tensor("int64", selfCategories),
    elo_oppo: new ort.Tensor("int64", oppoCategories),
  };
  const outputs = await runExclusive(() => active.run(feeds));

  const logits = outputs.logits_maia.data as Float32Array;
  const values = outputs.logits_value.data as Float32Array;
  // Read the policy width off the tensor rather than hardcoding 1880 — the move
  // table and the graph are pinned to one commit together, but the whole point
  // of pinning is that nothing else has to assume the number.
  const width = Number(outputs.logits_maia.dims.at(-1));

  const inputNames = [...active.inputNames];
  const outputNames = [...active.outputNames];

  return decoders.map(({ blackToMove, legalIndices }, i) => ({
    policy: decodePolicy(
      logits.subarray(i * width, (i + 1) * width),
      legalIndices,
      blackToMove,
      reversed,
    ),
    value: Number(values[i]),
    inputNames,
    outputNames,
  }));
}

/**
 * Full policy and value at one position, with Maia's two rating inputs set
 * independently.
 *
 * `evaluateMaia` reuses one rating for both, which is right for gameplay ("we
 * both think we're this rating" is good enough to pick a move) and wrong for
 * inference: the rating estimator sweeps `elo_self` across all nine buckets as
 * its hypothesis while `elo_oppo` has to stay pinned to the opponent who is
 * actually sitting there. Hence the split.
 *
 * Both arguments are `eloToCategory()` outputs - bucket indices on the model's
 * own scale, 1-9 for the named tiers, 0 for "below 1100" and 10 for "2000 and
 * up" - NOT raw ratings. The spec calls these `selfBucket`/`oppoBucket`; they're
 * named for categories here because `RatingBucket` in lib/analysis means a
 * rating (1100-1900), and one word covering both scales is a bug waiting to be
 * written.
 */
export async function evaluateMaiaAt(
  fen: string,
  selfCategory: number,
  oppoCategory: number,
): Promise<MaiaEvaluation> {
  const [only] = await evaluateMaiaRows([{ fen, selfCategory, oppoCategory }]);
  return only;
}

/** One position in a batched request. Ratings here are real ratings, not categories. */
export interface MaiaBatchRow {
  fen: string;
  /** Whoever is to move at `fen`. Supplies `elo_self` via its `ratingTier`. */
  config: EngineConfig;
  /**
   * Rating for `elo_oppo`. Defaults to `config.ratingTier`, which is what every
   * caller on the gameplay path wants and what the single-position path has
   * always done — so leaving it off reproduces today's behaviour exactly.
   */
  oppoRatingTier?: number;
}

/**
 * Many positions, one forward pass. Same contract as `evaluateMaia` per row.
 *
 * This exists for Monte Carlo rollouts, where N playouts advance a ply each and
 * would otherwise be N sequential `session.run()` calls per ply. What batching
 * actually buys, measured rather than assumed (`web/scripts/probe-maia-graph.mjs`):
 * about 10% — 27.3ms/position at N=1 against 24.2 at N=30. Total FLOPs are
 * conserved and this backend gets almost nothing extra from a bigger batch, so
 * the real win is 4,000 sequential awaits collapsing into ~40, not wall clock.
 * Budget rollout cost as (positions x ~25ms), whatever the batch size.
 *
 * The graph does support it: `boards` is declared `["batch_size",18,8,8]`, and
 * row *i* of the `[N,1880]` output was verified bit-identical to evaluating that
 * position alone — with two *distinct* positions, since identical ones would
 * hide a transposed row.
 */
export async function evaluateMaiaBatch(rows: MaiaBatchRow[]): Promise<MaiaEvaluation[]> {
  return evaluateMaiaRows(
    rows.map(({ fen, config, oppoRatingTier }) => ({
      fen,
      selfCategory: eloToCategory(config.ratingTier ?? 1500),
      oppoCategory: eloToCategory(oppoRatingTier ?? config.ratingTier ?? 1500),
    })),
  );
}

/**
 * Full policy and value for a position. Exported mainly so the verification page
 * can check that the rating input actually changes the output.
 *
 * Both rating tensors get the same category, which is what every caller on the
 * gameplay path wants. `evaluateMaiaAt` is the same forward pass with the two
 * pulled apart.
 */
export async function evaluateMaia(
  fen: string,
  config: EngineConfig
): Promise<MaiaEvaluation> {
  const category = eloToCategory(config.ratingTier ?? 1500);
  return evaluateMaiaAt(fen, category, category);
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

  return uciToMove(policy[0].uci);
}

/** `e7e8q` -> `{ from: "e7", to: "e8", promotion: "q" }`. */
export function uciToMove(uci: string): EngineMove {
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci.slice(4, 5) : undefined,
  };
}

/**
 * Draws one move from a policy at a given temperature.
 *
 * Rollouts need this because `getMaiaMove` takes the argmax: N playouts of the
 * top move are N copies of the same game, which measures the top-policy line
 * rather than what a population of players does.
 *
 * Raising each already-renormalised probability to `1/temperature` and
 * renormalising is exactly equivalent to dividing the raw logits by
 * `temperature` and re-softmaxing over the same legal subset — the
 * pre-renormalisation constant cancels — so this is a pure function on the
 * `policy` array, with no need to plumb raw logits out of the session.
 *
 * `temperature = 1` samples the distribution Maia was cross-entropy-trained to
 * match human move frequencies with, which is why it's the default rather than a
 * tuned knob. Below 1 sharpens toward argmax (narrower spread, but by
 * suppressing real behavioural variance, not by being more precise); above 1
 * flattens toward uniform and biases the whole estimate toward "random legal
 * move". `temperature = 0` is argmax, kept as an explicit case because 1/0 is
 * undefined — and it doubles as a test hook: at 0 this must return `policy[0]`.
 */
export function sampleFromPolicy(
  policy: MaiaEvaluation["policy"],
  temperature: number,
  rng: () => number = Math.random,
): string {
  if (policy.length === 0) throw new Error("sampleFromPolicy called with no moves");
  if (temperature <= 0) return policy[0].uci;

  const weights = policy.map((move) => move.probability ** (1 / temperature));
  const total = weights.reduce((a, b) => a + b, 0);

  // A very low temperature raises small probabilities to a power that underflows
  // to zero; if every weight underflows there's nothing to sample from, and the
  // sharpened distribution's answer is the top move anyway.
  if (!(total > 0) || !Number.isFinite(total)) return policy[0].uci;

  const threshold = rng() * total;
  let cumulative = 0;
  for (let i = 0; i < policy.length; i++) {
    cumulative += weights[i];
    if (threshold < cumulative) return policy[i].uci;
  }
  // Only reachable through floating-point slack, or an rng() that returns 1.
  return policy[policy.length - 1].uci;
}
