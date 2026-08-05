// The scoring maths for the Maia calibration audit. Pure: no model, no chess, no
// I/O, no randomness except where a seed is handed in.
//
// It lives in its own module for one reason, and it is the reason the audit can
// be believed at all. Verification checks 1 and 2 feed synthetic predictors with
// known answers through this code, and the real audit feeds Maia through *the
// same functions*. A separate "test implementation" of ECE would only prove that
// two pieces of arithmetic agree; running one implementation both ways is what
// makes "ECE 0.004 on a perfectly-calibrated predictor" evidence that the number
// printed for Maia means what it says.
//
// Vocabulary, kept straight because the two are constantly confused:
//   accuracy    - is argmax p(m) the move the human played? (top1/top3 below)
//   calibration - across all the times a probability of 0.3 was quoted, was the
//                 thing quoted at 0.3 true about 30% of the time? (ECE below)
// A model can be accurate and badly calibrated, or calibrated and inaccurate.

// ── small shared helpers ─────────────────────────────────────────────────────

export function mean(xs) {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** mulberry32 - a seeded PRNG so every synthetic run is reproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Softmax over one position's legal-move logits, at temperature `T`.
 *
 * This is deliberately the same shape as decodePolicy's softmax in
 * web/lib/chess/engineMaia.ts - max-subtracted, over the legal subset only - with
 * the single addition of the temperature divisor. At T = 1 it must reproduce that
 * function exactly, and the audit asserts precisely that rather than assuming it:
 * if this drifted from the app's own decode, every number here would describe a
 * model the app doesn't run.
 */
export function softmaxLegal(logits, T = 1) {
  const scaled = T === 1 ? logits : logits.map((l) => l / T);
  const max = Math.max(...scaled);
  const exp = scaled.map((l) => Math.exp(l - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  return exp.map((e) => e / sum);
}

// ── binning and ECE ──────────────────────────────────────────────────────────

/**
 * Equal-count (quantile) bins over (score, outcome) pairs.
 *
 * The primary binning, and not the obvious one, because chess policies are
 * violently skewed: most legal moves in most positions carry well under 1% of
 * the mass and a couple of candidates carry nearly all of it. Equal-width bins
 * over [0,1] therefore pile ~90% of all pairs into the bottom bin and leave the
 * high-confidence bins - the ones anything downstream actually depends on -
 * sparse enough to be noise. Equal-count bins buy a stable rate in every bin at
 * the cost of data-dependent edges, which is the right trade when the question
 * is "is the number trustworthy *where it is large*".
 */
export function equalCountBins(pairs, binCount = 12) {
  if (pairs.length === 0) return [];
  const sorted = [...pairs].sort((a, b) => a.s - b.s);
  const bins = [];
  for (let b = 0; b < binCount; b++) {
    const start = Math.floor((b * sorted.length) / binCount);
    const end = Math.floor(((b + 1) * sorted.length) / binCount);
    if (end <= start) continue;
    const slice = sorted.slice(start, end);
    bins.push(summarizeBin(slice, slice[0].s, slice[slice.length - 1].s));
  }
  return bins;
}

/** Equal-width bins over [0,1]. Reported as the familiar picture, not as primary. */
export function equalWidthBins(pairs, binCount = 10) {
  const buckets = Array.from({ length: binCount }, () => []);
  for (const pair of pairs) {
    const index = Math.min(binCount - 1, Math.floor(pair.s * binCount));
    buckets[index].push(pair);
  }
  return buckets
    .map((slice, i) => (slice.length ? summarizeBin(slice, i / binCount, (i + 1) / binCount) : null))
    .filter(Boolean);
}

function summarizeBin(slice, lo, hi) {
  return {
    lo,
    hi,
    n: slice.length,
    conf: mean(slice.map((p) => p.s)),
    acc: mean(slice.map((p) => p.o)),
  };
}

/**
 * ECE = Σ_b (n_b / N) · |acc_b − conf_b|.
 *
 * A weighted average of how far each bin's realised rate sits from the
 * confidence it was quoted at. 0 is perfect; the scale is "probability points",
 * so 0.05 means the model's numbers are off by about 5 points on average.
 */
export function expectedCalibrationError(bins) {
  const total = bins.reduce((sum, b) => sum + b.n, 0);
  if (total === 0) return 0;
  return bins.reduce((sum, b) => sum + (b.n / total) * Math.abs(b.acc - b.conf), 0);
}

/** Largest single-bin gap. ECE can hide a bad bin behind a lot of good ones. */
export function maxCalibrationError(bins) {
  return bins.reduce((worst, b) => Math.max(worst, Math.abs(b.acc - b.conf)), 0);
}

// ── the scoring pass ─────────────────────────────────────────────────────────

/**
 * Score a set of positions at one temperature.
 *
 * Each row is `{ logits, playedIndex }`, where `logits` are the raw per-legal-move
 * logits for that position and `playedIndex` says which of them the human played.
 * Rows carrying `playedIndex < 0` (the played move missing from the policy table)
 * are dropped and counted - scoring them would mean inventing an outcome.
 *
 * Everything the audit reports comes out of this one function, so a change to how
 * a probability is derived cannot reach one metric without reaching all of them.
 */
export function scoreRows(rows, T = 1) {
  const pairs = [];       // every (position, legal move) pair - the literal question
  const topPairs = [];    // one pair per position, at its argmax - Guo et al.'s variant
  const perRow = [];
  let skipped = 0;

  for (const row of rows) {
    if (!(row.playedIndex >= 0)) {
      skipped++;
      continue;
    }
    const probs = softmaxLegal(row.logits, T);
    const played = probs[row.playedIndex];

    let bestIndex = 0;
    for (let i = 1; i < probs.length; i++) if (probs[i] > probs[bestIndex]) bestIndex = i;

    // Rank of the played move, for top-3 - counted rather than sorted, since the
    // arrays are short and sorting each one is the expensive way to ask.
    let rank = 0;
    for (let i = 0; i < probs.length; i++) if (probs[i] > played) rank++;

    let sumSquares = 0;
    for (let i = 0; i < probs.length; i++) {
      const outcome = i === row.playedIndex ? 1 : 0;
      sumSquares += (probs[i] - outcome) ** 2;
      pairs.push({ s: probs[i], o: outcome });
    }
    topPairs.push({ s: probs[bestIndex], o: bestIndex === row.playedIndex ? 1 : 0 });

    perRow.push({
      bucket: row.bucket,
      legalCount: probs.length,
      played,
      top1: rank === 0 ? 1 : 0,
      top3: rank < 3 ? 1 : 0,
      // Textbook multiclass Brier: penalises mass parked on obviously-wrong moves
      // too, which BS_played cannot see. Its scale depends on how many legal moves
      // the position had, so it is only comparable across similar branching.
      bsFull: sumSquares,
      // The simpler "how wrong was the probability on the move actually played".
      // Not "the Brier score" in the standard sense - both are reported, labelled,
      // so neither gets quoted as the other.
      bsPlayed: (1 - played) ** 2,
      // No epsilon clamp needed: p is a softmax over the legal set and the played
      // move is in that set, so it is a ratio of positive exponentials, never 0.
      logLoss: -Math.log(played),
    });
  }

  return {
    n: perRow.length,
    skipped,
    top1: mean(perRow.map((r) => r.top1)),
    top3: mean(perRow.map((r) => r.top3)),
    bsFull: mean(perRow.map((r) => r.bsFull)),
    bsPlayed: mean(perRow.map((r) => r.bsPlayed)),
    logLoss: mean(perRow.map((r) => r.logLoss)),
    meanLegalMoves: mean(perRow.map((r) => r.legalCount)),
    pairs,
    topPairs,
    perRow,
  };
}

/** Everything the reliability half of the report needs, from a scored pass. */
export function reliability(scored, { binCount = 12 } = {}) {
  const allPairs = equalCountBins(scored.pairs, binCount);
  const allWidth = equalWidthBins(scored.pairs, 10);
  const top = equalCountBins(scored.topPairs, Math.min(binCount, 10));
  return {
    allPairsEqualCount: { bins: allPairs, ece: expectedCalibrationError(allPairs), mce: maxCalibrationError(allPairs) },
    allPairsEqualWidth: { bins: allWidth, ece: expectedCalibrationError(allWidth), mce: maxCalibrationError(allWidth) },
    top1Only: { bins: top, ece: expectedCalibrationError(top), mce: maxCalibrationError(top) },
  };
}

// ── temperature scaling ──────────────────────────────────────────────────────

/**
 * Fit one scalar T minimising held-out mean negative log likelihood of the moves
 * humans actually played.
 *
 * T > 1 means the model was overconfident and its logits need flattening; T < 1
 * means underconfident. This touches no model weight - it is a rescale applied to
 * logits *after* the session returns, the same category of operation as the
 * softmax-over-legal-moves the app already does, with one extra divisor. Worth
 * being explicit about because "calibrating a model" sounds adjacent to training
 * one, and not training is this project's hardest constraint.
 *
 * Coarse grid first, then golden-section refine. The grid is not just belt and
 * braces: NLL in T is only reliably unimodal in practice, not by proof, so the
 * curve is returned alongside the answer for a human to glance at rather than
 * being hidden inside an optimiser.
 */
export function fitTemperature(rows, { lo = 0.25, hi = 4, gridSteps = 24, tolerance = 1e-3 } = {}) {
  const nll = (T) => scoreRows(rows, T).logLoss;

  const curve = [];
  for (let i = 0; i <= gridSteps; i++) {
    const T = lo * (hi / lo) ** (i / gridSteps); // geometric: T and 1/T get equal attention
    curve.push({ T, nll: nll(T) });
  }
  let best = curve.reduce((a, b) => (b.nll < a.nll ? b : a));

  // Golden-section inside the bracketing grid cells around the coarse winner.
  const index = curve.indexOf(best);
  let a = curve[Math.max(0, index - 1)].T;
  let b = curve[Math.min(curve.length - 1, index + 1)].T;
  const phi = (Math.sqrt(5) - 1) / 2;
  let c = b - phi * (b - a);
  let d = a + phi * (b - a);
  let fc = nll(c);
  let fd = nll(d);
  while (b - a > tolerance) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - phi * (b - a);
      fc = nll(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + phi * (b - a);
      fd = nll(d);
    }
  }
  const T = (a + b) / 2;
  return { T, nll: nll(T), curve, gridBest: best };
}

// ── rendering ────────────────────────────────────────────────────────────────

/**
 * The reliability diagram, as text: predicted on the left, realised beside it,
 * and the bin population, because a bin holding 40 pairs deserves to look
 * different from one holding 40,000. `·` marks the perfect-calibration line the
 * bin's confidence sits at, `#` where it actually landed.
 */
export function renderDiagram(bins, { width = 44 } = {}) {
  const total = bins.reduce((sum, b) => sum + b.n, 0);
  const lines = [
    "    bin range          n     conf     acc      gap  " + "predicted · vs realised #".padEnd(width),
  ];
  for (const bin of bins) {
    const gap = bin.acc - bin.conf;
    const track = Array.from({ length: width }, () => " ");
    const at = (v) => Math.max(0, Math.min(width - 1, Math.round(v * (width - 1))));
    track[at(bin.conf)] = "·";
    track[at(bin.acc)] = track[at(bin.acc)] === "·" ? "*" : "#";
    lines.push(
      `  ${bin.lo.toFixed(3)}-${bin.hi.toFixed(3)} ` +
        `${String(bin.n).padStart(7)} ` +
        `${bin.conf.toFixed(4)} ${bin.acc.toFixed(4)} ` +
        `${(gap >= 0 ? "+" : "") + gap.toFixed(4)}  ` +
        `|${track.join("")}|`,
    );
  }
  lines.push(`  ${bins.length} bins, ${total} pairs   (* = they coincide)`);
  return lines.join("\n");
}
