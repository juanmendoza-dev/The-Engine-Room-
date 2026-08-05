// Proves the scoring harness isn't lying, before anything it says about Maia is
// worth reading. Verification checks 1 and 2 of
// docs/specs/2026-08-05-maia-calibration-audit.md, plus one the spec doesn't ask
// for (check 3 here) that validates the remedy rather than the diagnosis.
//
// Pure Node: no model, no Chrome, no network, ~2 seconds. Nothing here touches
// chess at all - it feeds (probability, outcome) pairs with known answers through
// the exact functions in lib/calibration.mjs that the real audit uses. A
// perfectly-calibrated predictor must score ECE near zero; a deliberately
// over- or under-confident one must score visibly worse in *both* directions,
// because a metric that only punishes overconfidence would call an underconfident
// Maia healthy.
//
// usage: node scripts/verify-calibration-harness.mjs

import {
  fitTemperature,
  mulberry32,
  reliability,
  renderDiagram,
  scoreRows,
} from "./lib/calibration.mjs";

const checks = [];
function check(label, ok, detail) {
  checks.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`);
}

// ── synthetic corpus ─────────────────────────────────────────────────────────

/** Normal deviate via Box-Muller, off the seeded uniform stream. */
function gaussian(rng) {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/**
 * One synthetic "position": a true distribution over K options, an outcome drawn
 * from it, and *reported* logits distorted by `sharpen`.
 *
 * The shape is deliberately chess-like rather than uniform - logits spread by a
 * normal, so one option usually dominates and a long tail carries almost nothing.
 * That matters because it is exactly the skew that makes equal-width binning
 * useless, and a harness validated only on flat distributions would never show it.
 *
 * `sharpen = 1` is a perfectly calibrated reporter: the probabilities it quotes
 * are the ones outcomes are drawn from. `sharpen > 1` quotes a sharper
 * distribution than reality (overconfident); `< 1` quotes a flatter one
 * (underconfident). Because reported logits are `sharpen · ln(p)`, dividing them
 * by `sharpen` recovers `p` exactly - which is what makes check 3 a real test of
 * the temperature fit and not a tautology.
 */
function syntheticRow(rng, sharpen) {
  const k = 3 + Math.floor(rng() * 38); // 3-40 legal moves, like a real board
  const raw = Array.from({ length: k }, () => gaussian(rng) * 2);

  const max = Math.max(...raw);
  const exp = raw.map((l) => Math.exp(l - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  const trueProbs = exp.map((e) => e / sum);

  let threshold = rng();
  let playedIndex = k - 1;
  for (let i = 0; i < k; i++) {
    threshold -= trueProbs[i];
    if (threshold <= 0) {
      playedIndex = i;
      break;
    }
  }

  return { logits: trueProbs.map((p) => sharpen * Math.log(p)), playedIndex };
}

const corpus = (n, sharpen, seed) => {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, () => syntheticRow(rng, sharpen));
};

function summarize(label, rows) {
  const scored = scoreRows(rows);
  const rel = reliability(scored);
  console.log(
    `  ${label.padEnd(26)} ECE ${rel.allPairsEqualCount.ece.toFixed(5)}` +
      `   MCE ${rel.allPairsEqualCount.mce.toFixed(5)}` +
      `   logloss ${scored.logLoss.toFixed(4)}` +
      `   BS_full ${scored.bsFull.toFixed(4)}` +
      `   top1 ${(100 * scored.top1).toFixed(1)}%`,
  );
  return { scored, ece: rel.allPairsEqualCount.ece, rel };
}

// ── check 1: a perfectly calibrated predictor scores ~0, and improves with n ──

console.log("== check 1: perfectly calibrated synthetic predictor ==");
const small = summarize("calibrated, n=2,000", corpus(2_000, 1, 11));
const large = summarize("calibrated, n=20,000", corpus(20_000, 1, 12));

check(
  "calibrated predictor scores near-zero ECE",
  large.ece < 0.01,
  `ECE ${large.ece.toFixed(5)} at n=20,000, want < 0.01`,
);
// Checked at two sizes on purpose. ECE is biased upward by finite samples - each
// bin's realised rate is noisy - so "approximately zero" on one sample size is a
// claim about the sample, not about the estimator. It has to *shrink*.
check(
  "ECE shrinks as the sample grows",
  large.ece < small.ece,
  `n=2,000 -> ${small.ece.toFixed(5)}   n=20,000 -> ${large.ece.toFixed(5)}`,
);

console.log("\n  reliability diagram, calibrated predictor at n=20,000:");
console.log(renderDiagram(large.rel.allPairsEqualCount.bins));

// ── check 2: both directions of miscalibration score visibly worse ───────────

console.log("\n== check 2: deliberately miscalibrated predictors ==");
const over = summarize("overconfident (x1.6)", corpus(20_000, 1.6, 12));
const under = summarize("underconfident (x0.6)", corpus(20_000, 0.6, 12));

for (const [name, bad] of [["overconfident", over], ["underconfident", under]]) {
  check(
    `${name} predictor scores markedly worse on ECE`,
    bad.ece > 5 * large.ece,
    `${bad.ece.toFixed(5)} vs calibrated ${large.ece.toFixed(5)} (want >5x)`,
  );
  check(
    `${name} predictor scores worse on log loss and Brier`,
    bad.scored.logLoss > large.scored.logLoss && bad.scored.bsFull > large.scored.bsFull,
    `logloss ${bad.scored.logLoss.toFixed(4)} vs ${large.scored.logLoss.toFixed(4)}, ` +
      `BS_full ${bad.scored.bsFull.toFixed(4)} vs ${large.scored.bsFull.toFixed(4)}`,
  );
}

// Top-1 accuracy must NOT move: sharpening a distribution cannot reorder it, so
// the argmax is the same move in all three corpora. This is the check that the
// harness is really separating calibration from accuracy - if these three
// differed, the two ideas would be tangled somewhere in scoreRows.
check(
  "accuracy is untouched by miscalibration (it is a different question)",
  Math.abs(over.scored.top1 - large.scored.top1) < 1e-12 &&
    Math.abs(under.scored.top1 - large.scored.top1) < 1e-12,
  `top1 ${(100 * large.scored.top1).toFixed(3)}% / ${(100 * over.scored.top1).toFixed(3)}% / ` +
    `${(100 * under.scored.top1).toFixed(3)}%`,
);

console.log("\n  reliability diagram, overconfident predictor:");
console.log(renderDiagram(over.rel.allPairsEqualCount.bins));

// ── check 3: the temperature fit recovers a distortion it was not told about ──
// Not in the spec's plan. The spec proposes temperature scaling as the remedy if
// Maia turns out miscalibrated, and there is no point applying a remedy whose
// machinery has never been shown to work on a case with a known answer.

console.log("\n== check 3: temperature fit recovers a known distortion ==");
for (const sharpen of [1.6, 0.6, 1.0]) {
  const rows = corpus(20_000, sharpen, 12);
  const split = Math.floor(rows.length / 2);
  const fit = fitTemperature(rows.slice(0, split));
  const heldOut = rows.slice(split);
  const before = scoreRows(heldOut).logLoss;
  const after = scoreRows(heldOut, fit.T).logLoss;

  check(
    `sharpen x${sharpen} -> fitted T recovers it (want ~${sharpen})`,
    Math.abs(fit.T - sharpen) < 0.08,
    `fitted T = ${fit.T.toFixed(4)}; held-out log loss ${before.toFixed(4)} -> ${after.toFixed(4)}`,
  );
  // Not "after <= before". Fitting T on a predictor that needs no correction
  // still pays for the sampling noise in T, so the already-calibrated case is
  // *expected* to come back a hair worse on held-out data - measured at +0.00012
  // nats, or 0.007%. Asserting a strict improvement there would be asserting that
  // an estimator has no variance. What matters is that the cost is negligible
  // when there is nothing to fix, and a real gain when there is.
  const damage = (after - before) / before;
  check(
    `sharpen x${sharpen} -> correction costs nothing meaningful on held-out data`,
    damage < 0.001,
    `${before.toFixed(5)} -> ${after.toFixed(5)} (${(100 * damage).toFixed(3)}%)`,
  );
}

// ── verdict ──────────────────────────────────────────────────────────────────

const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
if (failed) console.log("harness is NOT trustworthy - do not read the Maia numbers");
process.exitCode = failed ? 1 : 0;
