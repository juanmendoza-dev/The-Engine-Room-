// Runs maia_rapid.onnx under plain Node, using the app's own encoder and decoder.
//
// The app's evaluateMaiaAt cannot be called from here - it goes through load(),
// which throws "Maia runs in the browser only" on purpose, sets
// ort.env.wasm.wasmPaths to a URL path that only exists when Next is serving, and
// streams the weights over fetch with a progress bar nobody is watching offline.
// So this module owns the session, and *only* the session. Everything that
// decides what a number means -
//
//   mirrorFen, boardToTensor    the 18-plane encoding
//   legalPolicyIndices          which policy slots are legal moves here
//   decodePolicy                softmax over those, back to board coordinates
//   eloToCategory               rating -> the model's bucket index
//
// - is imported from web/lib/chess/engineMaia.ts rather than reimplemented, so
// the audit is measuring the pipeline the app actually ships. Node 24 strips the
// types on import; no build step, no loader flag. (It prints one
// MODULE_TYPELESS_PACKAGE_JSON warning on the way, which is noise - adding
// "type": "module" to web/package.json to silence it would be a change to the
// Next app to quiet a script.)
//
// onnxruntime-web, not onnxruntime-node: the wasm backend runs perfectly well
// outside a browser (web/scripts/probe-maia-graph.mjs proved that during Task 14)
// and it is the package the app already depends on. onnxruntime-node would mean a
// native build - the likelier install failure on Windows, for no benefit.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as ort from "onnxruntime-web";

import {
  boardToTensor,
  decodePolicy,
  eloToCategory,
  legalPolicyIndices,
  mirrorFen,
  mirrorMove,
} from "../../lib/chess/engineMaia.ts";

export { eloToCategory };

// Same pinned commit of our own mirror the app fetches from, deliberately: an
// audit of a different build of the weights than the one deployed would be an
// audit of nothing. If engineMaia.ts's ASSET_BASE ever moves, this has to move
// with it - it is not exported there, so this is a copy that needs watching.
const ASSET_BASE =
  "https://raw.githubusercontent.com/juanmendoza-dev/engine-room-assets/7c916f4d794ff411ffe6d0be85c8b1c75e61c8fe/maia2";

const PLANE_FLOATS = 18 * 64;

/** Where the 93 MB of weights get parked between runs. Never inside the repo. */
export function defaultCacheDir() {
  return process.env.MAIA_CACHE_DIR ?? join(tmpdir(), "engine-room-maia-cache");
}

async function cachedFetch(url, path, label) {
  if (existsSync(path)) return readFile(path);

  process.stdout.write(`  downloading ${label} ...`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} fetch failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(path, bytes);
  process.stdout.write(` ${(bytes.byteLength / 1e6).toFixed(1)} MB, cached\n`);
  return bytes;
}

/**
 * Load the model once and hand back a batched evaluator.
 *
 * `evaluateRows` takes `{ fen, selfCategory, oppoCategory }` - categories, not
 * ratings, exactly like evaluateMaiaAt - and returns, per row:
 *
 *   policy       the app's own decoded output, sorted best-first (parity anchor)
 *   legalUcis    legal moves in policy-index order, real board coordinates
 *   legalLogits  the raw logit behind each of those, same order
 *   value        the value head, untransformed
 *
 * The audit needs `legalLogits` because temperature scaling divides logits before
 * the softmax, and decodePolicy has already done the softmax by the time it
 * returns. Both come out of the same forward pass and the same legal-move list,
 * and the audit asserts that re-softmaxing legalLogits at T=1 reproduces `policy`
 * to floating-point slack - which is what stops the raw-logit path from quietly
 * becoming a second implementation.
 */
export async function loadMaiaForNode({ cacheDir = defaultCacheDir(), quiet = false } = {}) {
  await mkdir(cacheDir, { recursive: true });

  const log = (line) => {
    if (!quiet) console.log(line);
  };

  const [modelBytes, tableBytes] = await Promise.all([
    cachedFetch(`${ASSET_BASE}/maia_rapid.onnx`, join(cacheDir, "maia_rapid.onnx"), "maia_rapid.onnx (93 MB)"),
    cachedFetch(`${ASSET_BASE}/all_moves.json`, join(cacheDir, "all_moves.json"), "all_moves.json"),
  ]);

  const moveTable = JSON.parse(tableBytes.toString("utf8"));
  const reversed = [];
  for (const [uci, index] of Object.entries(moveTable)) reversed[index] = uci;

  // Single-threaded to match the app. The app's reason is COOP/COEP headers it
  // deliberately doesn't serve; here it is simply to measure the same thing.
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = "error";

  const started = performance.now();
  const session = await ort.InferenceSession.create(new Uint8Array(modelBytes));
  log(`  session ready in ${((performance.now() - started) / 1000).toFixed(1)}s ` +
    `(${session.inputNames.join(", ")} -> ${session.outputNames.join(", ")})`);

  async function evaluateRows(requests) {
    if (requests.length === 0) return [];
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
      return { blackToMove, legalIndices: legalPolicyIndices(encodedFen, moveTable) };
    });

    const outputs = await session.run({
      boards: new ort.Tensor("float32", boards, [n, 18, 8, 8]),
      elo_self: new ort.Tensor("int64", selfCategories),
      elo_oppo: new ort.Tensor("int64", oppoCategories),
    });

    const logits = outputs.logits_maia.data;
    const values = outputs.logits_value.data;
    const width = Number(outputs.logits_maia.dims.at(-1));

    return decoders.map(({ blackToMove, legalIndices }, i) => {
      const rowLogits = logits.subarray(i * width, (i + 1) * width);
      return {
        policy: decodePolicy(rowLogits, legalIndices, blackToMove, reversed),
        legalUcis: legalIndices.map((index) =>
          blackToMove ? mirrorMove(reversed[index]) : reversed[index],
        ),
        legalLogits: legalIndices.map((index) => rowLogits[index]),
        value: Number(values[i]),
      };
    });
  }

  /**
   * Run many requests through `evaluateRows` in fixed-size batches.
   *
   * Batch size is a scheduling choice, not a speed one: Task 14 measured batching
   * at about 10% (27.3 ms/position at N=1 against 24.2 at N=30), because total
   * FLOPs are conserved and this backend gets little from a wider batch. What it
   * does buy is thousands of sequential awaits collapsing into dozens. Budget any
   * pass here as (positions x ~25 ms) regardless of batch size.
   */
  async function evaluateAll(requests, { batchSize = 32, onProgress } = {}) {
    const out = [];
    for (let i = 0; i < requests.length; i += batchSize) {
      out.push(...(await evaluateRows(requests.slice(i, i + batchSize))));
      onProgress?.(Math.min(i + batchSize, requests.length), requests.length);
    }
    return out;
  }

  return { evaluateRows, evaluateAll, session, moveTable, reversed };
}
