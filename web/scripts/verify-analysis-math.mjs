// Verification for the SPRT / rating maths (Task 16). Pure Node — no Chrome, no
// engines, no npm dependencies, nothing that takes 500ms to think.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/verify-analysis-math.mjs
//
// (The warning is Node noticing `web/package.json` has no `"type": "module"` and
// reparsing the .ts files as ESM. Harmless; suppressed so it doesn't bury the
// output. Drop the flag if you want to see it.)
//
// Project convention, per every task before this one: no assertion framework,
// no test runner. Checks with known answers, PASS/FAIL lines a human reads.
//
// The design principle behind what's checked here: a rating fit and a sequential
// test are exactly the kind of code that produces confident, plausible,
// well-formatted, *wrong* numbers. Nothing crashes when a sign is flipped or a
// second derivative is off by a factor — you just get an Elo gap that is quietly
// too small forever. So the checks below are mostly of the form "compute the same
// thing a second, independent way and see if they agree":
//
//   - the model's probabilities against numbers hand-worked in the spec
//   - the fit's optimum against a numerically-differentiated likelihood
//   - the fit's standard errors against a numerical Hessian
//   - the fit itself against an independent MM implementation written below
//   - the SPRT's claimed error rates against its observed ones over many series
//   - Glicko-2 against the worked example in Glickman's own paper
//
// Anything that only checks "it returned a number in a plausible range" is not a
// check. That's the trap this file exists to avoid.

import { register } from "node:module";

register("./ts-extension-resolver.mjs", import.meta.url);

const { davidsonProbs, expectedScore, expectedLlrPerGame, expectedGamesToDecision, llrIncrement } =
  await import("../lib/analysis/eloModel.ts");
const { createSprt, recordGame } = await import("../lib/analysis/sprt.ts");
const { fitBradleyTerryDavidson, davidsonLogLikelihood } = await import("../lib/analysis/ratingBT.ts");
const { updateGlicko2, DEFAULT_TAU } = await import("../lib/analysis/ratingGlicko2.ts");

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let failures = 0;
let checks = 0;

function pass(label, detail) {
  checks++;
  console.log(`PASS  ${label}${detail ? ` — ${detail}` : ""}`);
}

function fail(label, detail) {
  checks++;
  failures++;
  console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
}

function check(label, ok, detail) {
  (ok ? pass : fail)(label, detail);
}

function near(label, actual, expected, tolerance, unit = "") {
  const diff = Math.abs(actual - expected);
  check(
    label,
    diff <= tolerance,
    `got ${fmt(actual)}${unit}, want ${fmt(expected)}${unit} ±${fmt(tolerance)}`,
  );
}

function fmt(x) {
  if (!Number.isFinite(x)) return String(x);
  const a = Math.abs(x);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return x.toExponential(3);
  return String(Math.round(x * 1e4) / 1e4);
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

/** Deterministic RNG so anything odd here can be re-run and re-read. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawOutcome(rng, probs) {
  const u = rng();
  if (u < probs.pWin) return "win";
  if (u < probs.pWin + probs.pDraw) return "draw";
  return "loss";
}

/**
 * A synthetic series between two labels, `a` at `deltaTrue` Elo over `b`.
 * Colours alternate: if the aggregation in ratingBT.ts ignored which side a
 * preset was on, an all-one-colour fixture would sail straight past it.
 */
function syntheticGames(rng, n, deltaTrue, gammaTrue, a = "A", b = "B") {
  const probs = davidsonProbs(deltaTrue, gammaTrue);
  const games = [];
  for (let i = 0; i < n; i++) {
    const outcome = drawOutcome(rng, probs);
    const aIsWhite = i % 2 === 0;
    const result =
      outcome === "draw" ? "1/2-1/2" : (outcome === "win") === aIsWhite ? "1-0" : "0-1";
    games.push({ white: aIsWhite ? a : b, black: aIsWhite ? b : a, result });
  }
  return games;
}

function fittedDelta(fit, a = "A", b = "B") {
  const ra = fit.ratings.find((r) => r.presetId === a);
  const rb = fit.ratings.find((r) => r.presetId === b);
  return ra.elo - rb.elo;
}

// ---------------------------------------------------------------------------
// 1. The model, against numbers worked by hand in the spec
// ---------------------------------------------------------------------------

section("1. Davidson model vs the spec's hand-worked numbers");

{
  const p = davidsonProbs(200, 0.5);
  near("P(win) at δ=200, γ=0.5", p.pWin, 0.62602, 5e-5);
  near("P(draw) at δ=200, γ=0.5", p.pDraw, 0.17602, 5e-5);
  near("P(loss) at δ=200, γ=0.5", p.pLoss, 0.19796, 5e-5);
  near("probabilities sum to 1", p.pWin + p.pDraw + p.pLoss, 1, 1e-12);

  // The spec's central claim about why Davidson beats half-win scoring.
  near("expected score at δ=200, γ=0.5 (spec: 0.714)", expectedScore(200, 0.5), 0.714, 5e-4);
  near("pure-logistic expected score at δ=200 (spec: 0.760)", expectedScore(200, 0), 0.7598, 5e-4);

  // ...and the bias it predicts: fit that 0.714 back through a no-draw curve and
  // you recover 159 Elo, not 200. Solved here rather than asserted.
  const target = expectedScore(200, 0.5);
  const backedOut = -400 * Math.log10(1 / target - 1);
  near("half-win scoring understates 200 Elo as ~159 (spec)", backedOut, 159, 1);

  near("γ=0 recovers plain Bradley-Terry (no draws)", davidsonProbs(200, 0).pDraw, 0, 0);
  near("δ=0 is symmetric", davidsonProbs(0, 0.5).pWin - davidsonProbs(0, 0.5).pLoss, 0, 1e-15);
}

{
  // The two rows of the spec's "games to a decision" table.
  near("E₁[Z] for elo0=0 elo1=200, γ=0.5 (spec: 0.119)", expectedLlrPerGame(200, 0, 200, 0.5), 0.119, 5e-4);
  near("E₁[Z] for elo0=0 elo1=50, γ=0.5 (spec: 0.0082)", expectedLlrPerGame(50, 0, 50, 0.5), 0.0082, 5e-5);

  const wide = expectedGamesToDecision(0, 200, 0.05, 0.05, 0.5);
  const narrow = expectedGamesToDecision(0, 50, 0.05, 0.05, 0.5);
  check(
    "expected games, 200-Elo question (spec: ≈20–25)",
    wide.underH1 >= 20 && wide.underH1 <= 25,
    `E[N|H1] = ${fmt(wide.underH1)}`,
  );
  check(
    "expected games, 50-Elo question (spec: ≈320)",
    narrow.underH1 >= 300 && narrow.underH1 <= 340,
    `E[N|H1] = ${fmt(narrow.underH1)}`,
  );
  check(
    "precision costs ~14x the games of a sanity check (spec's ballpark)",
    narrow.underH1 / wide.underH1 > 11 && narrow.underH1 / wide.underH1 < 17,
    `ratio ${fmt(narrow.underH1 / wide.underH1)}x`,
  );

  // KL divergence is non-negative, and zero only when the hypotheses coincide.
  check(
    "E[Z] ≥ 0 under whichever hypothesis is true",
    expectedLlrPerGame(200, 0, 200, 0.5) > 0 && -expectedLlrPerGame(0, 0, 200, 0.5) > 0,
    `E₁=${fmt(expectedLlrPerGame(200, 0, 200, 0.5))}, E₀=${fmt(expectedLlrPerGame(0, 0, 200, 0.5))}`,
  );
}

{
  // The spec's "degenerate probabilities" error case: γ=0 makes P(draw) exactly
  // zero under both hypotheses, and a drawn game must not poison the sum.
  const z = llrIncrement("draw", 0, 200, 0);
  check("a draw at γ=0 yields a finite LLR increment", Number.isFinite(z), `Z = ${fmt(z)}`);
}

// ---------------------------------------------------------------------------
// 2. SPRT error rates — the check that actually matters
// ---------------------------------------------------------------------------

section("2. SPRT observed error rates over many series");

{
  const ALPHA = 0.05;
  const BETA = 0.05;
  const GAMMA = 0.5;
  const ELO0 = 0;
  const ELO1 = 200;
  const SERIES = 400;
  const MAX_GAMES = 2000;

  const config = {
    a: "A",
    b: "B",
    elo0: ELO0,
    elo1: ELO1,
    alpha: ALPHA,
    beta: BETA,
    gamma: GAMMA,
    maxGames: MAX_GAMES,
  };

  function runSeries(rng, deltaTrue) {
    const probs = davidsonProbs(deltaTrue, GAMMA);
    let state = createSprt(config);
    while (state.decision === "continue") state = recordGame(state, drawOutcome(rng, probs));
    return state;
  }

  for (const [name, deltaTrue, wanted] of [
    ["H1 true (δ=200)", ELO1, "accept-h1"],
    ["H0 true (δ=0)", ELO0, "accept-h0"],
  ]) {
    const rng = mulberry32(deltaTrue === ELO1 ? 20260805 : 771);
    let correct = 0;
    let capped = 0;
    let totalGames = 0;
    for (let i = 0; i < SERIES; i++) {
      const state = runSeries(rng, deltaTrue);
      if (state.decision === wanted) correct++;
      if (state.decision === "max-games") capped++;
      totalGames += state.games;
    }
    const rate = correct / SERIES;
    const target = deltaTrue === ELO1 ? 1 - BETA : 1 - ALPHA;
    // Wald's bounds ignore boundary overshoot, so the real error rates come in a
    // little *better* than nominal. A rate below nominal is the failure worth
    // catching; well above it is expected and fine.
    check(
      `${name}: decides correctly ≈${(target * 100).toFixed(0)}% of the time`,
      rate >= target - 0.05 && rate <= 1,
      `${(rate * 100).toFixed(1)}% over ${SERIES} series, ${capped} hit the ${MAX_GAMES}-game cap`,
    );

    const meanN = totalGames / SERIES;
    const predicted =
      deltaTrue === ELO1
        ? expectedGamesToDecision(ELO0, ELO1, ALPHA, BETA, GAMMA).underH1
        : expectedGamesToDecision(ELO0, ELO1, ALPHA, BETA, GAMMA).underH0;
    check(
      `${name}: mean stopping count within 3x of Wald's E[N]`,
      meanN > predicted / 3 && meanN < predicted * 3,
      `observed ${fmt(meanN)} games, predicted ${fmt(predicted)}`,
    );
  }

  // The awkward case: the truth sits exactly between the hypotheses, where the
  // test has no "right" answer and is only obliged to stop. A test that runs
  // forever here is useless however good its error rates are at the endpoints.
  const rng = mulberry32(99);
  const tally = { "accept-h0": 0, "accept-h1": 0, "max-games": 0 };
  for (let i = 0; i < 200; i++) tally[runSeries(rng, 100).decision]++;
  check(
    "a mid-way truth (δ=100) still reaches a boundary every time",
    tally["max-games"] === 0,
    `h0 ${tally["accept-h0"]}, h1 ${tally["accept-h1"]}, capped ${tally["max-games"]}`,
  );

  // A decided state must be immutable — continuing past a boundary would be a
  // different test with different error rates than the α/β the config claims.
  let decided = createSprt(config);
  while (decided.decision === "continue") decided = recordGame(decided, "win");
  const after = recordGame(decided, "loss");
  check(
    "recordGame is a no-op once decided",
    after === decided || (after.games === decided.games && after.llr === decided.llr),
    `${decided.decision} after ${decided.games} games`,
  );
}

// ---------------------------------------------------------------------------
// 3. Bradley-Terry recovery
// ---------------------------------------------------------------------------

section("3. Bradley-Terry + Davidson recovers a known (δ, γ)");

const DELTA_TRUE = 150;
const GAMMA_TRUE = 0.45;
const PRESETS = ["A", "B"];

{
  const rng = mulberry32(4242);
  const stream = syntheticGames(rng, 2000, DELTA_TRUE, GAMMA_TRUE);

  for (const n of [100, 500, 2000]) {
    const fit = fitBradleyTerryDavidson(stream.slice(0, n), PRESETS, "B", 0);
    const delta = fittedDelta(fit);
    const se = fit.ratings.find((r) => r.presetId === "A").stderr;
    console.log(
      `      N=${String(n).padStart(4)}  δ̂ = ${fmt(delta).padStart(8)} ±${fmt(se)}  ` +
        `γ̂ = ${fmt(fit.drawParam)}  (${fit.iterations} iters, converged=${fit.converged})`,
    );
    if (n === 2000) {
      // Stated tolerance: the asymptotic sd here is ~9 Elo, so ±30 is a little
      // over 3 sd — tight enough to catch a real bias, loose enough not to fail
      // on one unlucky seed.
      near("δ̂ at N=2000 (tolerance ±30 Elo)", delta, DELTA_TRUE, 30, " Elo");
      near("γ̂ at N=2000 (tolerance ±0.15)", fit.drawParam, GAMMA_TRUE, 0.15);
      check("fit converged", fit.converged, `${fit.iterations} iterations`);
    }
  }
}

{
  // Colour bookkeeping: mirror every game (swap sides, flip the result) and the
  // fit must be unchanged. This is the check that catches reading "1-0" as
  // "preset A won" — which is right in half the games and silently wrong in the
  // other half, and which no amount of eyeballing a plausible Elo would reveal.
  const rng = mulberry32(31337);
  const games = syntheticGames(rng, 800, DELTA_TRUE, GAMMA_TRUE);
  const mirrored = games.map((g) => ({
    white: g.black,
    black: g.white,
    result: g.result === "1-0" ? "0-1" : g.result === "0-1" ? "1-0" : "1/2-1/2",
  }));
  const a = fittedDelta(fitBradleyTerryDavidson(games, PRESETS, "B", 0));
  const b = fittedDelta(fitBradleyTerryDavidson(mirrored, PRESETS, "B", 0));
  near("mirroring every game's colours changes nothing", b, a, 1e-9, " Elo");
}

{
  // Half-win scoring on the same data, to show the bias is real and not just
  // algebra in the spec. Fitting with γ pinned to 0 is exactly the "score each
  // draw 0.5/0.5 and fit no-draw BT" alternative.
  const rng = mulberry32(5150);
  const games = syntheticGames(rng, 4000, 200, 0.5);
  const davidson = fittedDelta(fitBradleyTerryDavidson(games, PRESETS, "B", 0));
  const halfWin = fittedDelta(fitBradleyTerryDavidson(games, PRESETS, "B", 0, { fixedGamma: 0 }));
  console.log(`      Davidson δ̂ = ${fmt(davidson)},  half-win δ̂ = ${fmt(halfWin)},  truth 200`);
  check(
    "half-win scoring understates the gap on real samples too",
    halfWin < davidson - 20 && Math.abs(halfWin - 159) < 25,
    `half-win landed at ${fmt(halfWin)} Elo against a true 200`,
  );
}

// ---------------------------------------------------------------------------
// 4. The fit's own internals, checked a different way
// ---------------------------------------------------------------------------

section("4. Fit optimum and standard errors vs numerical differentiation");

{
  const rng = mulberry32(20260816);
  const games = syntheticGames(rng, 1200, DELTA_TRUE, GAMMA_TRUE);
  const fit = fitBradleyTerryDavidson(games, PRESETS, "B", 0);
  const deltaHat = fittedDelta(fit);
  const gammaHat = fit.drawParam;

  // Parameterised the way the fit is: free β for A (B is the anchor at 0), and
  // θ = ln γ.
  const logL = (delta, theta) => davidsonLogLikelihood(games, PRESETS, [delta, 0], Math.exp(theta));

  const H_DELTA = 0.05;
  const H_THETA = 1e-3;
  const thetaHat = Math.log(gammaHat);

  const dDelta =
    (logL(deltaHat + H_DELTA, thetaHat) - logL(deltaHat - H_DELTA, thetaHat)) / (2 * H_DELTA);
  const dTheta =
    (logL(deltaHat, thetaHat + H_THETA) - logL(deltaHat, thetaHat - H_THETA)) / (2 * H_THETA);

  // At a maximum both partials vanish. If the analytic gradient the fit uses had
  // a wrong constant, it would stop somewhere this numerical one is not zero.
  near("∂logL/∂δ ≈ 0 at the fitted optimum", dDelta, 0, 1e-4);
  near("∂logL/∂θ ≈ 0 at the fitted optimum", dTheta, 0, 1e-4);

  // Numerical 2x2 Hessian, inverted independently of ratingBT.ts's own
  // information matrix. This is the check on the second-derivative algebra —
  // including the β/θ cross term, which is the easiest piece to get wrong and
  // the one that only ever shows up as intervals that are slightly too narrow.
  const f = (d, t) => logL(d, t);
  const hDD =
    (f(deltaHat + H_DELTA, thetaHat) - 2 * f(deltaHat, thetaHat) + f(deltaHat - H_DELTA, thetaHat)) /
    (H_DELTA * H_DELTA);
  const hTT =
    (f(deltaHat, thetaHat + H_THETA) - 2 * f(deltaHat, thetaHat) + f(deltaHat, thetaHat - H_THETA)) /
    (H_THETA * H_THETA);
  const hDT =
    (f(deltaHat + H_DELTA, thetaHat + H_THETA) -
      f(deltaHat + H_DELTA, thetaHat - H_THETA) -
      f(deltaHat - H_DELTA, thetaHat + H_THETA) +
      f(deltaHat - H_DELTA, thetaHat - H_THETA)) /
    (4 * H_DELTA * H_THETA);

  // Covariance = inverse of the negated Hessian.
  const [a11, a12, a22] = [-hDD, -hDT, -hTT];
  const det = a11 * a22 - a12 * a12;
  const numericSeDelta = Math.sqrt(a22 / det);
  const numericSeGamma = gammaHat * Math.sqrt(a11 / det);

  const reportedSeDelta = fit.ratings.find((r) => r.presetId === "A").stderr;
  near("stderr(δ̂) matches a numerical Hessian", reportedSeDelta, numericSeDelta, 0.05, " Elo");
  near("stderr(γ̂) matches a numerical Hessian", fit.drawParamStderr, numericSeGamma, 0.005);

  // And the diagonal-only shortcut, to show the cross term is worth carrying:
  const naive = Math.sqrt(1 / a11);
  console.log(
    `      full-covariance stderr ${fmt(reportedSeDelta)} Elo vs diagonal-only ${fmt(naive)} Elo`,
  );
}

{
  // Interval coverage: over many replications, the truth should sit inside
  // δ̂ ± 1.96·stderr about 95% of the time. A wrong Hessian passes every check
  // above and fails this one.
  const REPLICATIONS = 300;
  const PER_SERIES = 200;
  const rng = mulberry32(60613);
  let covered = 0;
  let usable = 0;
  for (let i = 0; i < REPLICATIONS; i++) {
    const games = syntheticGames(rng, PER_SERIES, DELTA_TRUE, GAMMA_TRUE);
    const fit = fitBradleyTerryDavidson(games, PRESETS, "B", 0);
    const se = fit.ratings.find((r) => r.presetId === "A").stderr;
    if (!fit.converged || se === null) continue;
    usable++;
    if (Math.abs(fittedDelta(fit) - DELTA_TRUE) <= 1.96 * se) covered++;
  }
  const rate = covered / usable;
  check(
    "95% intervals cover the truth about 95% of the time",
    rate >= 0.9 && rate <= 0.99,
    `${(rate * 100).toFixed(1)}% over ${usable} replications of ${PER_SERIES} games`,
  );
}

// ---------------------------------------------------------------------------
// 5. An independent implementation of the same fit
// ---------------------------------------------------------------------------

section("5. Newton fit vs an independent MM (Zermelo) implementation");

{
  // Plain Bradley-Terry's MM update, written here from Zermelo (1929) /
  // Hunter (2004) rather than imported, so it shares no code with the module
  // under test:  π_i ← w_i / Σ_j n_ij/(π_i + π_j)
  //
  // Only the no-draw case: the Davidson-extended MM update needs a second
  // minorization on the √(π_iπ_j) term, and hand-deriving that from memory would
  // be inventing a reference rather than checking against one. The spec says the
  // same — "see Hunter (2004) rather than a hand-derivation here". The shared
  // Bradley-Terry core is what this exercises, and a sign error in it would show
  // up here regardless of the tie term.
  function fitMM(games, presetIds, anchorId, anchorElo) {
    const idx = new Map(presetIds.map((id, i) => [id, i]));
    const k = presetIds.length;
    const wins = new Array(k).fill(0);
    const n = Array.from({ length: k }, () => new Array(k).fill(0));

    for (const g of games) {
      const w = idx.get(g.white);
      const b = idx.get(g.black);
      n[w][b]++;
      n[b][w]++;
      if (g.result === "1-0") wins[w]++;
      else if (g.result === "0-1") wins[b]++;
      else throw new Error("this MM implementation is the no-draw case only");
    }

    let pi = new Array(k).fill(1);
    for (let iter = 0; iter < 20000; iter++) {
      const next = pi.slice();
      for (let i = 0; i < k; i++) {
        let denom = 0;
        for (let j = 0; j < k; j++) if (j !== i) denom += n[i][j] / (pi[i] + pi[j]);
        if (denom > 0) next[i] = wins[i] / denom;
      }
      const scale = next.reduce((s, x) => s + x, 0) / k;
      for (let i = 0; i < k; i++) next[i] /= scale;
      const moved = Math.max(...next.map((x, i) => Math.abs(x - pi[i])));
      pi = next;
      if (moved < 1e-14) break;
    }

    const beta = pi.map((p) => 400 * Math.log10(p));
    const shift = anchorElo - beta[idx.get(anchorId)];
    return beta.map((b) => b + shift);
  }

  const rng = mulberry32(8675309);
  // γ_true = 0 so the data genuinely has no draws for the MM version to choke on.
  const games = syntheticGames(rng, 3000, 175, 0);
  const three = [
    ...games,
    ...syntheticGames(rng, 3000, -120, 0, "C", "B"),
    ...syntheticGames(rng, 2000, 90, 0, "A", "C"),
  ];
  const ids = ["A", "B", "C"];

  const newton = fitBradleyTerryDavidson(three, ids, "B", 0, { fixedGamma: 0 });
  const mm = fitMM(three, ids, "B", 0);

  const worst = Math.max(...ids.map((id, i) => Math.abs(newton.ratings[i].elo - mm[i])));
  console.log(
    `      Newton: ${ids.map((id, i) => `${id}=${fmt(newton.ratings[i].elo)}`).join("  ")}`,
  );
  console.log(`      MM:     ${ids.map((id, i) => `${id}=${fmt(mm[i])}`).join("  ")}`);
  check("two independent fits agree to <0.01 Elo", worst < 0.01, `worst gap ${fmt(worst)} Elo`);

  const llNewton = davidsonLogLikelihood(three, ids, newton.ratings.map((r) => r.elo), 0);
  const llMM = davidsonLogLikelihood(three, ids, mm, 0);
  check(
    "and land on the same log-likelihood",
    Math.abs(llNewton - llMM) < 1e-6,
    `${fmt(llNewton)} vs ${fmt(llMM)}`,
  );
}

// ---------------------------------------------------------------------------
// 6. Ford's condition
// ---------------------------------------------------------------------------

section("6. Ford's condition — refusing to rate what the data can't rate");

{
  // Two families that never play each other. This is the realistic failure: the
  // schedule forgot cross-engine pairings, and a naive fit would happily print
  // an Elo gap between a Stockfish preset and a Maia one it has no evidence for.
  const rng = mulberry32(1957);
  const disconnected = [
    ...syntheticGames(rng, 200, 100, 0.4, "SF-a", "SF-b"),
    ...syntheticGames(rng, 200, 100, 0.4, "Maia-a", "Maia-b"),
  ];
  const fit = fitBradleyTerryDavidson(disconnected, ["SF-a", "SF-b", "Maia-a", "Maia-b"], "SF-a", 1800);
  const rated = fit.ratings.filter((r) => r.rated).map((r) => r.presetId);
  check(
    "disconnected engine families are reported, not invented",
    rated.length === 2 && rated.includes("SF-a") && rated.includes("SF-b"),
    `rated: ${rated.join(", ") || "(none)"}; warnings: ${fit.warnings.length}`,
  );
  const maia = fit.ratings.find((r) => r.presetId === "Maia-a");
  check("the unrated side says why", !maia.rated && !!maia.note, maia.note ?? "(no note)");
  check(
    "every rated Elo is finite",
    fit.ratings.filter((r) => r.rated).every((r) => Number.isFinite(r.elo)),
  );
}

{
  // A preset that swept: the MLE runs off to +∞ rather than converging.
  const sweeper = [];
  for (let i = 0; i < 40; i++) {
    sweeper.push({ white: i % 2 ? "God" : "Mortal", black: i % 2 ? "Mortal" : "God", result: i % 2 ? "1-0" : "0-1" });
  }
  const rng = mulberry32(11);
  sweeper.push(...syntheticGames(rng, 100, 0, 0.5, "Mortal", "Peer"));
  const fit = fitBradleyTerryDavidson(sweeper, ["God", "Mortal", "Peer"], "Mortal", 1800);
  const god = fit.ratings.find((r) => r.presetId === "God");
  check(
    "a 100%-sweeping preset is flagged, not given a bogus ±∞",
    !god.rated && Number.isFinite(god.elo),
    god.note ?? "(no note)",
  );
  check(
    "the presets that can still be rated, are",
    fit.ratings.find((r) => r.presetId === "Peer").rated,
    `Peer at ${fmt(fit.ratings.find((r) => r.presetId === "Peer").elo)} Elo`,
  );
}

{
  const fit = fitBradleyTerryDavidson([], ["A", "B"], "A", 1800);
  check("no games at all is handled", !fit.converged && fit.ratings.every((r) => !r.rated), fit.warnings[0]);
}

// ---------------------------------------------------------------------------
// 7. Glicko-2
// ---------------------------------------------------------------------------

section("7. Glicko-2 against the worked example in Glickman's paper");

{
  // glicko.net/glicko/glicko2.pdf, "Example calculation": a 1500/200/0.06 player,
  // τ=0.5, beats a 1400/30, loses to a 1550/100 and a 1700/300. The paper's
  // published answers are r'=1464.06, RD'=151.52, σ'=0.05999.
  const result = updateGlicko2(
    { rating: 1500, rd: 200, volatility: 0.06 },
    [
      { opponent: { rating: 1400, rd: 30, volatility: 0.06 }, score: 1 },
      { opponent: { rating: 1550, rd: 100, volatility: 0.06 }, score: 0 },
      { opponent: { rating: 1700, rd: 300, volatility: 0.06 }, score: 0 },
    ],
    0.5,
  );
  near("new rating (paper: 1464.06)", result.rating, 1464.06, 0.02);
  near("new RD (paper: 151.52)", result.rd, 151.52, 0.02);
  near("new volatility (paper: 0.05999)", result.volatility, 0.05999, 1e-5);
}

{
  // An idle period must *widen* RD — the branch that distinguishes Glicko-2 from
  // "Elo with error bars".
  const idle = updateGlicko2({ rating: 1500, rd: 200, volatility: 0.06 }, [], DEFAULT_TAU);
  check("an empty rating period widens RD", idle.rd > 200, `200 → ${fmt(idle.rd)}`);
  near("...and leaves the rating alone", idle.rating, 1500, 0);
}

{
  // Recovery on the same synthetic truth the BT fit was given, plus the caveat
  // the spec asks to be *noted* rather than treated as a failure: with static
  // opponents and a dense schedule there is no drift for volatility to track, so
  // σ walks down and stays there.
  const rng = mulberry32(777);
  const opponent = { rating: 1500, rd: 30, volatility: 0.06 };
  let player = { rating: 1500, rd: 350, volatility: 0.06 };
  const probs = davidsonProbs(DELTA_TRUE, GAMMA_TRUE);
  const volatilities = [];

  for (let period = 0; period < 30; period++) {
    const games = [];
    for (let i = 0; i < 20; i++) {
      const outcome = drawOutcome(rng, probs);
      games.push({ opponent, score: outcome === "win" ? 1 : outcome === "draw" ? 0.5 : 0 });
    }
    player = updateGlicko2(player, games, DEFAULT_TAU);
    volatilities.push(player.volatility);
  }

  console.log(
    `      after 600 games: ${fmt(player.rating)} ±${fmt(player.rd)} (σ ${fmt(player.volatility)})`,
  );
  // Glicko-2's logistic scale and Davidson's aren't the same model, so this is a
  // directional check, not an equality: a player 150 Davidson-Elo above a 1500
  // opponent must land clearly above 1500 and in the right neighbourhood.
  check(
    "Glicko-2 puts the stronger player where BT does, roughly",
    player.rating > 1550 && player.rating < 1500 + DELTA_TRUE + 60,
    `${fmt(player.rating)} against a true gap of ${DELTA_TRUE} Elo over a 1500 opponent`,
  );
  check(
    "RD narrows as games accumulate",
    player.rd < 60,
    `350 → ${fmt(player.rd)}`,
  );
  check(
    "volatility settles rather than tracking anything (expected — see module note)",
    Math.abs(volatilities.at(-1) - volatilities.at(-5)) < 5e-4,
    `σ last five periods: ${volatilities.slice(-5).map(fmt).join(", ")}`,
  );
}

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`} — ${checks} checks`);
console.log("done");
process.exit(failures === 0 ? 0 : 1);
