// Does maia_rapid.onnx mean what it says?
//
// Implements docs/specs/2026-08-05-maia-calibration-audit.md. When Maia puts 30%
// on a move, do humans in that rating bucket really play it about 30% of the
// time? That is a different question from "does Maia pick the same move a human
// picked" (accuracy, ~50% published), and the two are scored separately here on
// purpose: a model can be accurate and badly calibrated, or calibrated and
// inaccurate, and only the calibration answer says whether anything built on the
// *number* attached to a move can trust it.
//
// Why anyone should care beyond tidiness: two features already read that number.
// docs/specs/2026-08-05-bayesian-rating-inference.md uses Maia's policy as a
// likelihood, and its own Risks section names this audit as the thing that would
// tell it whether its "80% credible interval" really covers 80%. An overconfident
// Maia sharpens that posterior faster than the evidence justifies.
//
// Runs offline under Node - nothing here touches the app, and none of it runs
// while a player is looking at a board. The one thing it borrows from the app is
// the pipeline itself (see scripts/lib/maiaNode.mjs), so the numbers describe the
// model as deployed rather than a re-encoding of it.
//
// Read scripts/verify-calibration-harness.mjs first if you doubt the scoring
// code: it feeds predictors with known answers through these same functions.
//
// usage:
//   node scripts/audit-maia-calibration.mjs
//   node scripts/audit-maia-calibration.mjs --rows 500 --gatePositions 100   (quick)
//   MAIA_CACHE_DIR=/somewhere node scripts/audit-maia-calibration.mjs

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  fitTemperature,
  mulberry32,
  renderDiagram,
  reliability,
  scoreRows,
  shuffled,
  softmaxLegal,
} from "./lib/calibration.mjs";
import { eloToCategory, loadMaiaForNode } from "./lib/maiaNode.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const opts = {
  rows: Infinity,
  gatePositions: 300,
  bins: 12,
  seed: 20260805,
  sample: resolve(HERE, "fixtures/maia-calibration-sample.jsonl"),
  out: resolve(HERE, "fixtures/maia-calibration-report.json"),
};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, "");
  if (!(key in opts)) throw new Error(`unknown option --${key}`);
  opts[key] = typeof opts[key] === "number" ? Number(process.argv[i + 1]) : process.argv[i + 1];
}

/** The nine buckets bayesian-rating-inference's posterior lives over. */
const NAMED_BUCKETS = [1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900];
const inNamedRange = (rating) => rating >= 1100 && rating < 2000;
const bucketOf = (rating) => Math.min(1900, Math.max(1100, Math.floor(rating / 100) * 100));

const checks = [];
function check(label, ok, detail) {
  checks.push({ label, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`);
}

const pct = (x) => `${(100 * x).toFixed(1)}%`;
const started = performance.now();
const report = { generatedFrom: opts.sample, checks: [] };

console.log("loading maia_rapid.onnx");
const maia = await loadMaiaForNode();

const progress = (label) => (done, total) => {
  if (done % 640 === 0 || done === total) {
    const rate = (performance.now() - started) / 1000;
    process.stdout.write(`\r  ${label}: ${done}/${total}  (${rate.toFixed(0)}s elapsed)   `);
  }
};
const endProgress = () => process.stdout.write("\r" + " ".repeat(70) + "\r");

// ── 0. is this the same pipeline the app runs? ───────────────────────────────
// Everything below is worthless if this Node harness encodes positions even
// slightly differently from the browser. Two independent ways of checking, both
// against numbers written down before this script existed.

console.log("\n== 0. pipeline parity with the deployed app ==");

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
// Byte-for-byte the `freeQueen` position from web/app/dev/maia-test/page.tsx, not
// a reconstruction of it. An earlier draft here rebuilt it from the description
// in docs/maia-notes.md, dropped one black pawn, and scored 92.8% instead of the
// recorded 93.9% - close enough to look like drift in the model and actually a
// different position. Copy these anchors, never retype them.
const QUEEN_HANGING = "rnb1kbnr/pppppppp/8/8/3q4/4P3/PPPP1PPP/RNBQKBNR w KQkq - 0 1";

const [startEval] = await maia.evaluateRows([
  { fen: START, selfCategory: eloToCategory(1500), oppoCategory: eloToCategory(1500) },
]);
check(
  "start-position value head reproduces docs/maia-notes.md's -0.1813",
  Math.abs(startEval.value - -0.1813) < 5e-4,
  `got ${startEval.value.toFixed(4)}`,
);

const afterE4 = await maia.evaluateAll(
  [1100, 1500, 1900].map((tier) => ({
    fen: AFTER_E4,
    selfCategory: eloToCategory(tier),
    oppoCategory: eloToCategory(tier),
  })),
);
const recorded = [0.319, 0.293, 0.326]; // maia-notes.md, "Rating responsiveness"
const gotE4 = afterE4.map((e) => e.policy.find((m) => m.uci === "g8f6")?.probability ?? 0);
check(
  "g8f6 after 1.e4 reproduces 31.9 / 29.3 / 32.6% across the three tiers",
  gotE4.every((p, i) => Math.abs(p - recorded[i]) < 0.002),
  gotE4.map((p) => pct(p)).join("  "),
);

const [hanging] = await maia.evaluateRows([
  { fen: QUEEN_HANGING, selfCategory: eloToCategory(1500), oppoCategory: eloToCategory(1500) },
]);
check(
  "the move-index sanity position still puts ~93.9% on exd4",
  hanging.policy[0].uci === "e3d4" && Math.abs(hanging.policy[0].probability - 0.939) < 0.005,
  `${hanging.policy[0].uci} ${pct(hanging.policy[0].probability)}`,
);

// The raw-logit path this audit needs for temperature scaling must agree with the
// app's own decodePolicy, or the two would be separate implementations wearing
// the same name - exactly the failure the shared-import design exists to prevent.
let worstParity = 0;
for (const evaluated of [startEval, hanging, ...afterE4]) {
  const probs = softmaxLegal(evaluated.legalLogits, 1);
  evaluated.legalUcis.forEach((uci, i) => {
    const fromApp = evaluated.policy.find((m) => m.uci === uci).probability;
    worstParity = Math.max(worstParity, Math.abs(fromApp - probs[i]));
  });
}
check(
  "re-softmaxing raw legal logits reproduces decodePolicy exactly",
  worstParity < 1e-9,
  `worst absolute difference ${worstParity.toExponential(2)} over 5 positions`,
);

// ── load the corpus ──────────────────────────────────────────────────────────

const corpus = (await readFile(opts.sample, "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))
  .slice(0, opts.rows === Infinity ? undefined : opts.rows);

console.log(`\ncorpus: ${corpus.length} rows, ${new Set(corpus.map((r) => r.game)).size} games`);

// ── 1. self-consistency gate (Option C) ──────────────────────────────────────
// The gate before any human number is worth reading. Take real positions, run one
// forward pass per bucket, treat that policy as ground truth, then draw simulated
// "plays" from it in software and score those draws with the same binning/ECE code
// the human rows will see. A correct pipeline must recover ECE near zero, because
// the outcomes were generated by exactly the distribution being scored. If it
// doesn't, the bug is in this harness, not in Maia's honesty.

console.log("\n== 1. self-consistency gate (Option C) ==");

const gateFens = corpus.slice(0, opts.gatePositions).map((row) => row.fen);
const gateRequests = [];
for (const fen of gateFens) {
  for (const bucket of NAMED_BUCKETS) {
    gateRequests.push({ fen, selfCategory: eloToCategory(bucket), oppoCategory: eloToCategory(bucket) });
  }
}
console.log(`  ${gateFens.length} positions x ${NAMED_BUCKETS.length} buckets = ${gateRequests.length} passes`);

const gateEvals = await maia.evaluateAll(gateRequests, { onProgress: progress("gate") });
endProgress();

const gateRng = mulberry32(opts.seed);
const gateRows = gateEvals.map((evaluated) => {
  const probs = softmaxLegal(evaluated.legalLogits, 1);
  let threshold = gateRng();
  let playedIndex = probs.length - 1;
  for (let i = 0; i < probs.length; i++) {
    threshold -= probs[i];
    if (threshold <= 0) {
      playedIndex = i;
      break;
    }
  }
  return { logits: evaluated.legalLogits, playedIndex, bucket: 0 };
});

const gateScored = scoreRows(gateRows);
const gateRel = reliability(gateScored, { binCount: opts.bins });
console.log(
  `  ECE ${gateRel.allPairsEqualCount.ece.toFixed(5)}   MCE ${gateRel.allPairsEqualCount.mce.toFixed(5)}` +
    `   logloss ${gateScored.logLoss.toFixed(4)}   over ${gateScored.pairs.length} pairs`,
);
check(
  "self-consistency: scoring Maia against its own samples recovers ECE ~ 0",
  gateRel.allPairsEqualCount.ece < 0.01,
  `ECE ${gateRel.allPairsEqualCount.ece.toFixed(5)}, want < 0.01`,
);
report.selfConsistency = {
  positions: gateFens.length,
  passes: gateRequests.length,
  ece: gateRel.allPairsEqualCount.ece,
  mce: gateRel.allPairsEqualCount.mce,
  logLoss: gateScored.logLoss,
};

// ── 2. the real pass, against human moves ────────────────────────────────────
// Headline convention: elo_oppo = elo_self, matching what getMaiaMove does on the
// gameplay path. The second pass below uses the PGN's true opponent rating, which
// is the comparison bayesian-rating-inference.md asked for before deciding whether
// marginalising elo_oppo is worth 9x the cost.

console.log("\n== 2. scoring Maia against human moves ==");

async function scoreCorpus(label, oppoFrom) {
  const requests = corpus.map((row) => ({
    fen: row.fen,
    selfCategory: eloToCategory(row.moverRating),
    oppoCategory: eloToCategory(oppoFrom(row)),
  }));
  const evaluated = await maia.evaluateAll(requests, { onProgress: progress(label) });
  endProgress();

  let missing = 0;
  const rows = evaluated.map((result, i) => {
    const playedIndex = result.legalUcis.indexOf(corpus[i].move);
    if (playedIndex < 0) missing++;
    return {
      logits: result.legalLogits,
      playedIndex,
      bucket: bucketOf(corpus[i].moverRating),
      inScope: inNamedRange(corpus[i].moverRating),
    };
  });
  return { rows, missing };
}

const matched = await scoreCorpus("matched elo_oppo", (row) => row.moverRating);
const trueOppo = await scoreCorpus("true elo_oppo", (row) => row.opponentRating);

check(
  "every played move was found in the policy's legal-move list",
  matched.missing === 0,
  `${matched.missing} of ${corpus.length} rows had no policy entry for the move played`,
);

// Headline is the nine named buckets, which is the scope
// bayesian-rating-inference's posterior lives over. All rows are reported too,
// since the model does have categories for "below 1100" and "2000 and up".
const scopeRows = matched.rows.filter((r) => r.inScope);
const headline = scoreRows(scopeRows);
const allRows = scoreRows(matched.rows);
const headlineRel = reliability(headline, { binCount: opts.bins });

console.log(
  `\n  in-scope rows (1100-1999): ${headline.n}   mean legal moves ${headline.meanLegalMoves.toFixed(1)}`,
);
console.log(`  top-1 ${pct(headline.top1)}   top-3 ${pct(headline.top3)}`);
console.log(`  log loss ${headline.logLoss.toFixed(4)} nats`);
console.log(`  BS_full ${headline.bsFull.toFixed(4)}   BS_played ${headline.bsPlayed.toFixed(4)}`);
console.log(
  `  ECE  all-pairs/equal-count ${headlineRel.allPairsEqualCount.ece.toFixed(5)}` +
    `   all-pairs/equal-width ${headlineRel.allPairsEqualWidth.ece.toFixed(5)}` +
    `   top-1-only ${headlineRel.top1Only.ece.toFixed(5)}`,
);
console.log(`  all rows incl. out-of-scope (${allRows.n}): top-1 ${pct(allRows.top1)}, ` +
  `log loss ${allRows.logLoss.toFixed(4)}`);

console.log("\n  reliability diagram - every (position, legal move) pair, equal-count bins:");
console.log(renderDiagram(headlineRel.allPairsEqualCount.bins));
console.log("\n  reliability diagram - top-1 only (Guo et al.'s variant), equal-count bins:");
console.log(renderDiagram(headlineRel.top1Only.bins));

// Check 5's sanity anchor. Not pass/fail on its own terms - it is here to catch a
// broken fixture pipeline, not to grade Maia against its paper.
check(
  "top-1 accuracy lands in the neighbourhood of the published ~50%",
  headline.top1 > 0.35 && headline.top1 < 0.6,
  `${pct(headline.top1)} - wildly outside this range would mean suspecting the fixture, not the model`,
);

// ── 3. does elo_oppo matter? ─────────────────────────────────────────────────

const trueScoped = scoreRows(trueOppo.rows.filter((r) => r.inScope));
const trueRel = reliability(trueScoped, { binCount: opts.bins });
console.log("\n== 3. matched elo_oppo vs the PGN's true opponent rating ==");
console.log(
  `  matched : log loss ${headline.logLoss.toFixed(4)}  top-1 ${pct(headline.top1)}  ` +
    `ECE ${headlineRel.allPairsEqualCount.ece.toFixed(5)}`,
);
console.log(
  `  true    : log loss ${trueScoped.logLoss.toFixed(4)}  top-1 ${pct(trueScoped.top1)}  ` +
    `ECE ${trueRel.allPairsEqualCount.ece.toFixed(5)}`,
);
const oppoDelta = Math.abs(trueScoped.logLoss - headline.logLoss);
console.log(
  `  |delta| log loss ${oppoDelta.toFixed(5)} nats - ` +
    (oppoDelta < 0.01
      ? "negligible, so bayesian-rating-inference's cheap fixed-default is safe"
      : "large enough that marginalising elo_oppo may be worth its 9x cost"),
);

// ── 4. per-bucket breakdown ──────────────────────────────────────────────────
// Where the audit can say something the headline can't. Rating-label noise is
// worst at bucket edges (a 1149 and a 1151 player are a coin flip apart), so a
// bucket that misbehaves alone is more likely a data artefact than a model fault.

console.log("\n== 4. per rating bucket ==");
console.log("  bucket      n   top-1   log loss      ECE");
const perBucket = [];
for (const bucket of NAMED_BUCKETS) {
  const rows = scopeRows.filter((r) => r.bucket === bucket);
  if (rows.length === 0) continue;
  const scored = scoreRows(rows);
  const rel = reliability(scored, { binCount: 8 });
  perBucket.push({
    bucket,
    n: scored.n,
    top1: scored.top1,
    logLoss: scored.logLoss,
    ece: rel.allPairsEqualCount.ece,
  });
  console.log(
    `  ${bucket}  ${String(scored.n).padStart(5)}  ${pct(scored.top1).padStart(6)}  ` +
      `${scored.logLoss.toFixed(4).padStart(8)}  ${rel.allPairsEqualCount.ece.toFixed(5).padStart(8)}`,
  );
}

// ── 5. temperature scaling ───────────────────────────────────────────────────
// The remedy, fit on a held-out split so the correction is not graded on the exam
// it wrote. Free in compute: the logits are already cached from the pass above, so
// this is a 1-D search over numbers in memory, not a model re-run per candidate T.
//
// Fitting T touches no model weight. It is one scalar divided into the logits
// *after* session.run() returns - the same category of operation as the
// softmax-over-legal-moves the app already does. That matters because this
// project's hardest constraint is "no training or fine-tuning, ever", and
// "calibrating a model" sounds adjacent to it without being it.

console.log("\n== 5. temperature scaling ==");
const split = Math.floor(scopeRows.length / 2);
const order = shuffled(scopeRows, mulberry32(opts.seed + 1));
const fitRows = order.slice(0, split);
const heldOut = order.slice(split);

const fit = fitTemperature(fitRows);
const beforeScored = scoreRows(heldOut);
const afterScored = scoreRows(heldOut, fit.T);
const beforeRel = reliability(beforeScored, { binCount: opts.bins });
const afterRel = reliability(afterScored, { binCount: opts.bins });

console.log(`  fitted T = ${fit.T.toFixed(4)} on ${fitRows.length} held-in rows`);
console.log(
  `  ${fit.T > 1.02 ? "T > 1: Maia is overconfident, its logits want flattening" :
     fit.T < 0.98 ? "T < 1: Maia is underconfident, its logits want sharpening" :
     "T ~ 1: no meaningful global miscalibration to correct"}`,
);
console.log(`  held-out (${heldOut.length} rows), before -> after:`);
console.log(`    log loss ${beforeScored.logLoss.toFixed(4)} -> ${afterScored.logLoss.toFixed(4)}`);
console.log(`    ECE      ${beforeRel.allPairsEqualCount.ece.toFixed(5)} -> ${afterRel.allPairsEqualCount.ece.toFixed(5)}`);
console.log(`    top-1    ${pct(beforeScored.top1)} -> ${pct(afterScored.top1)}   (must not move: T cannot reorder)`);

check(
  "temperature scaling cannot change accuracy",
  Math.abs(afterScored.top1 - beforeScored.top1) < 1e-12,
  `${pct(beforeScored.top1)} vs ${pct(afterScored.top1)}`,
);

// Per-bucket T, to answer the spec's "check whether a per-bucket T differs
// meaningfully before adding nine separate scalars".
const perBucketT = [];
for (const bucket of NAMED_BUCKETS) {
  const rows = fitRows.filter((r) => r.bucket === bucket);
  if (rows.length < 50) continue;
  perBucketT.push({ bucket, T: fitTemperature(rows).T, n: rows.length });
}
console.log(
  "  per-bucket T: " + perBucketT.map((b) => `${b.bucket}:${b.T.toFixed(2)}`).join("  "),
);
const spread = perBucketT.length
  ? Math.max(...perBucketT.map((b) => b.T)) - Math.min(...perBucketT.map((b) => b.T))
  : null;
console.log(
  spread === null
    ? "  (no bucket had the 50+ rows needed for its own fit - run the full corpus)"
    : `  spread ${spread.toFixed(3)} - ` +
        (spread < 0.15
          ? "one global T is enough; nine scalars would be fitting noise"
          : "buckets genuinely differ, a per-bucket T may be worth it"),
);

// ── report ───────────────────────────────────────────────────────────────────

report.corpus = { rows: corpus.length, inScope: headline.n, games: new Set(corpus.map((r) => r.game)).size };
report.headline = {
  convention: "elo_oppo = elo_self (matches getMaiaMove on the gameplay path)",
  scope: "movers rated 1100-1999, the nine buckets bayesian-rating-inference uses",
  n: headline.n,
  top1: headline.top1,
  top3: headline.top3,
  logLossNats: headline.logLoss,
  brierFull: headline.bsFull,
  brierPlayed: headline.bsPlayed,
  meanLegalMoves: headline.meanLegalMoves,
  eceAllPairsEqualCount: headlineRel.allPairsEqualCount.ece,
  eceAllPairsEqualWidth: headlineRel.allPairsEqualWidth.ece,
  eceTop1Only: headlineRel.top1Only.ece,
  mceAllPairsEqualCount: headlineRel.allPairsEqualCount.mce,
};
report.allRows = { n: allRows.n, top1: allRows.top1, logLossNats: allRows.logLoss };
report.reliabilityBins = headlineRel.allPairsEqualCount.bins;
report.top1OnlyBins = headlineRel.top1Only.bins;
report.eloOppo = {
  matchedLogLoss: headline.logLoss,
  trueLogLoss: trueScoped.logLoss,
  deltaNats: oppoDelta,
};
report.perBucket = perBucket;
report.temperature = {
  fitted: fit.T,
  heldOutRows: heldOut.length,
  logLossBefore: beforeScored.logLoss,
  logLossAfter: afterScored.logLoss,
  eceBefore: beforeRel.allPairsEqualCount.ece,
  eceAfter: afterRel.allPairsEqualCount.ece,
  perBucket: perBucketT,
  spread,
  curve: fit.curve,
};
report.checks = checks.map(({ label, ok, detail }) => ({ label, ok, detail }));
report.wallClockSeconds = (performance.now() - started) / 1000;

await writeFile(opts.out, JSON.stringify(report, null, 2));

const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed in ${report.wallClockSeconds.toFixed(0)}s`);
console.log(`report -> ${opts.out}`);
process.exitCode = failed ? 1 : 0;
