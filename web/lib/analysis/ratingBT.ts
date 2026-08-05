// Bradley-Terry with a Davidson draw term, fitted by maximum likelihood.
//
// What this answers: given a pile of finished games between presets, what Elo
// gaps best explain them — as opposed to the gaps the dropdown labels claim.
// Task 2's own notes admit the labels were never verified ("proves the options
// are accepted... does not prove the ELO settings change playing strength"), and
// this is the machinery that closes that.
//
// Why not just score draws as half a win and fit ordinary Bradley-Terry: the
// spec works the numbers, and the short version is that half-win scoring cannot
// tell "lots of close draws" (weak evidence) from the same score split entirely
// between decisive results (strong evidence). At a true 200-Elo gap with γ=0.5 it
// backs out ~159 Elo — a systematic understatement that grows with the draw rate.
// Fine as a cross-check, not as the number that ships.
//
// Spec: docs/specs/2026-08-05-sprt-engine-ratings.md ("Rating math")

import { davidsonProbs, halfRatio } from "./eloModel";
import type { BradleyTerryFit, MatchGameResult, RatingEstimate } from "./types";

/**
 * d(ln π)/d(β). π = 10^(β/400), so this is ln(10)/400 — and its reciprocal is
 * 173.7178, the same constant Glicko-2 uses to convert to its internal scale,
 * for exactly the same reason.
 */
const C = Math.LN10 / 400;

/** Everything the fit needs off a game. Any `MatchGameResult` satisfies it. */
export type FitGame = Pick<MatchGameResult, "white" | "black" | "result"> & {
  incomplete?: boolean;
};

export interface FitOptions {
  maxIterations?: number;
  /** Convergence is measured in *games* of residual, so this is scale-free. */
  tolerance?: number;
  /** Hold the tie parameter fixed instead of fitting it. */
  fixedGamma?: number;
}

interface Pair {
  /** Lower preset index. */
  lo: number;
  /** Higher preset index. */
  hi: number;
  n: number;
  /** Score (wins + half draws) accruing to `lo`. */
  scoreLo: number;
  draws: number;
}

interface PairView {
  other: number;
  n: number;
  /** Score accruing to the preset being differentiated. */
  score: number;
  draws: number;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function aggregate(
  games: FitGame[],
  index: Map<string, number>,
): { pairs: Pair[]; skipped: number } {
  const byKey = new Map<string, Pair>();
  let skipped = 0;

  for (const g of games) {
    if (g.incomplete) {
      skipped++;
      continue;
    }
    const w = index.get(g.white);
    const b = index.get(g.black);
    if (w === undefined || b === undefined || w === b) {
      skipped++;
      continue;
    }

    const lo = Math.min(w, b);
    const hi = Math.max(w, b);
    const key = `${lo}|${hi}`;
    let pair = byKey.get(key);
    if (!pair) {
      pair = { lo, hi, n: 0, scoreLo: 0, draws: 0 };
      byKey.set(key, pair);
    }

    pair.n++;
    if (g.result === "1/2-1/2") {
      pair.draws++;
      pair.scoreLo += 0.5;
    } else {
      // The winner by colour, mapped back to whichever index is `lo`.
      const winner = g.result === "1-0" ? w : b;
      if (winner === lo) pair.scoreLo += 1;
    }
  }

  return { pairs: [...byKey.values()], skipped };
}

/** Every pair a given preset appears in, oriented so `score` is that preset's. */
function viewsFor(pairs: Pair[], p: number): PairView[] {
  const out: PairView[] = [];
  for (const pair of pairs) {
    if (pair.lo === p) out.push({ other: pair.hi, n: pair.n, score: pair.scoreLo, draws: pair.draws });
    else if (pair.hi === p)
      out.push({ other: pair.lo, n: pair.n, score: pair.n - pair.scoreLo, draws: pair.draws });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ford's condition
// ---------------------------------------------------------------------------

/**
 * Ford (1957): the MLE exists and is unique only if the "who beat whom" digraph
 * is strongly connected. Two ways this bites here, and both are real rather than
 * theoretical:
 *
 *  - **Disconnected families.** Stockfish and Maia share one scale *only* because
 *    Model 1v1 lets them play each other. Schedule no cross-engine pairings and
 *    they are two islands with no exchange rate between them — a fit run anyway
 *    reports gaps it has no evidence for.
 *  - **A preset that swept.** Win every game with no draws and the likelihood
 *    increases without bound as that preset's Elo goes to +∞. The iterate runs
 *    off rather than converging.
 *
 * A draw is evidence in both directions, so it counts as an edge each way — the
 * natural reading of Ford's condition under Davidson, and it is what stops a
 * hard-fought all-draws pairing from being called disconnected.
 *
 * Returns the set of presets sharing a strongly-connected component with the
 * anchor; anything else cannot be placed on the anchor's scale.
 */
function rateableSet(pairs: Pair[], count: number, anchor: number): Set<number> {
  const edge: boolean[][] = Array.from({ length: count }, () => new Array<boolean>(count).fill(false));

  for (const p of pairs) {
    const loWins = p.scoreLo - p.draws / 2;
    const hiWins = p.n - p.draws - loWins;
    if (loWins > 0 || p.draws > 0) edge[p.lo][p.hi] = true;
    if (hiWins > 0 || p.draws > 0) edge[p.hi][p.lo] = true;
  }

  // Transitive closure. n<=6 presets here, so an O(n^3) Floyd-Warshall costs
  // nothing and is far harder to get wrong than a hand-rolled SCC pass.
  const reach = edge.map((row) => [...row]);
  for (let k = 0; k < count; k++)
    for (let i = 0; i < count; i++)
      if (reach[i][k]) for (let j = 0; j < count; j++) if (reach[k][j]) reach[i][j] = true;

  const set = new Set<number>([anchor]);
  for (let i = 0; i < count; i++) if (i !== anchor && reach[anchor][i] && reach[i][anchor]) set.add(i);
  return set;
}

// ---------------------------------------------------------------------------
// Linear algebra (small, so hand-rolled rather than a dependency)
// ---------------------------------------------------------------------------

/** Gauss-Jordan with partial pivoting. Null when the matrix is singular. */
function invert(matrix: number[][]): number[][] | null {
  const n = matrix.length;
  if (n === 0) return [];

  const a = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-14) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];

    const d = a[col][col];
    for (let j = 0; j < 2 * n; j++) a[col][j] /= d;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r][col];
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) a[r][j] -= factor * a[col][j];
    }
  }

  return a.map((row) => row.slice(n));
}

// ---------------------------------------------------------------------------
// The fit
// ---------------------------------------------------------------------------

/**
 * Log-likelihood of a game set under a given (β, γ). Exported because comparing
 * this number between two independent implementations is the cheapest possible
 * check that a fit converged to the same place — and because a fit that reports
 * a *lower* likelihood than a rival's answer has simply failed, whatever its
 * convergence flag says.
 *
 * `betas` is indexed the same way as `presetIds`.
 */
export function davidsonLogLikelihood(
  games: FitGame[],
  presetIds: string[],
  betas: number[],
  gamma: number,
): number {
  const index = new Map(presetIds.map((id, i) => [id, i]));
  const { pairs } = aggregate(games, index);
  let total = 0;
  for (const p of pairs) {
    const probs = davidsonProbs(betas[p.lo] - betas[p.hi], gamma);
    const loWins = p.scoreLo - p.draws / 2;
    const hiWins = p.n - p.draws - loWins;
    total +=
      loWins * Math.log(Math.max(1e-300, probs.pWin)) +
      hiWins * Math.log(Math.max(1e-300, probs.pLoss)) +
      p.draws * Math.log(Math.max(1e-300, probs.pDraw));
  }
  return total;
}

/**
 * Fit Elo per preset plus one shared tie parameter, anchored so the scale has a
 * zero point.
 *
 * **Coordinate-wise Newton, not MM.** The log-likelihood is strictly concave in
 * each β_i and in ln γ separately — the second derivative in β_i works out to
 * `-c² Σ n_ij (1 + γ(s+1/s)/4) / T²`, which is negative for any γ≥0 — so one
 * parameter at a time with an exact Newton step converges without step-size
 * tuning and without a linear-algebra dependency. The gradient has a pleasant
 * form worth knowing when reading the loop: it is exactly
 * `c × (actual score − expected score)`, summed over opponents, which is the
 * same shape as an Elo update.
 *
 * The anchor is held fixed rather than estimated, so every standard error here
 * is a *relative* one. The absolute numbers are only ever as good as the anchor
 * choice, and there is no external human pool to check it against.
 */
export function fitBradleyTerryDavidson(
  games: FitGame[],
  presetIds: string[],
  anchorPresetId: string,
  anchorElo: number,
  options: FitOptions = {},
): BradleyTerryFit {
  const { maxIterations = 500, tolerance = 1e-10, fixedGamma } = options;
  const warnings: string[] = [];
  const index = new Map(presetIds.map((id, i) => [id, i]));
  const count = presetIds.length;
  const anchor = index.get(anchorPresetId);

  const unrated = (note: string): BradleyTerryFit => ({
    ratings: presetIds.map((presetId) => ({
      presetId,
      elo: anchorElo,
      stderr: null,
      games: 0,
      score: 0,
      anchor: presetId === anchorPresetId,
      rated: false,
      note,
    })),
    drawParam: fixedGamma ?? 0,
    drawParamStderr: null,
    converged: false,
    iterations: 0,
    gamesUsed: 0,
    warnings: [...warnings, note],
  });

  if (anchor === undefined) return unrated(`anchor "${anchorPresetId}" is not one of the presets`);

  const { pairs: allPairs, skipped } = aggregate(games, index);
  if (skipped > 0) warnings.push(`${skipped} game(s) skipped: incomplete, or a preset not in the list`);
  if (allPairs.length === 0) return unrated("no usable games");

  const rateable = rateableSet(allPairs, count, anchor);
  // Only games *between* two rateable presets inform the fit — a game against an
  // unrated preset carries an unknown opponent strength and would drag the rest.
  const pairs = allPairs.filter((p) => rateable.has(p.lo) && rateable.has(p.hi));
  const gamesUsed = pairs.reduce((sum, p) => sum + p.n, 0);
  if (pairs.length === 0) return unrated("no games between presets on a common scale");

  const missing = presetIds.filter((_, i) => !rateable.has(i));
  if (missing.length > 0) {
    warnings.push(
      `not on the anchor's scale (Ford's condition): ${missing.join(", ")} — ` +
        `either no cross-engine games connect them, or they swept/were swept`,
    );
  }

  const free = [...rateable].filter((i) => i !== anchor).sort((a, b) => a - b);
  const betas = new Array<number>(count).fill(anchorElo);

  // γ init from the pooled draw rate: at δ=0, P(draw) = γ/(2+γ), so a draw rate
  // p implies γ = 2p/(1-p). Starting from the data beats starting from a guess.
  const totalDraws = pairs.reduce((sum, p) => sum + p.draws, 0);
  const drawRate = totalDraws / gamesUsed;
  let gamma = fixedGamma ?? Math.min(50, Math.max(1e-4, (2 * drawRate) / Math.max(1e-9, 1 - drawRate)));
  let fitGamma = fixedGamma === undefined;

  if (fitGamma && totalDraws === 0) {
    // The MLE is γ→0. Pin it there instead of letting ln γ walk to -∞.
    gamma = 0;
    fitGamma = false;
    warnings.push("no draws in the data, so the tie parameter is pinned at 0 (plain Bradley-Terry)");
  }
  if (fitGamma && totalDraws === gamesUsed) {
    gamma = 50;
    fitGamma = false;
    warnings.push("every game was drawn, so the tie parameter is pinned at its ceiling");
  }

  let iterations = 0;
  let converged = false;

  for (; iterations < maxIterations; iterations++) {
    let worstResidual = 0;

    for (const i of free) {
      let residual = 0; // actual score - expected score, in games
      let curvature = 0;
      for (const v of viewsFor(pairs, i)) {
        if (!rateable.has(v.other)) continue;
        const s = halfRatio(betas[i] - betas[v.other]);
        const t = s + 1 / s + gamma;
        residual += v.score - (v.n * (s + gamma / 2)) / t;
        curvature += (v.n * (1 + (gamma * (s + 1 / s)) / 4)) / (t * t);
      }
      if (curvature <= 0) continue;
      worstResidual = Math.max(worstResidual, Math.abs(residual));
      // step = -grad/hess with grad = C*residual and hess = -C^2*curvature.
      const step = residual / (C * curvature);
      betas[i] += Math.max(-400, Math.min(400, step));
    }

    if (fitGamma) {
      // Differentiated in θ = ln γ, which keeps γ positive for free and turns the
      // gradient into (actual draws - expected draws) exactly.
      let residual = 0;
      let curvature = 0;
      for (const p of pairs) {
        const s = halfRatio(betas[p.lo] - betas[p.hi]);
        const t = s + 1 / s + gamma;
        const pDraw = gamma / t;
        residual += p.draws - p.n * pDraw;
        curvature += p.n * pDraw * (1 - pDraw);
      }
      if (curvature > 0) {
        worstResidual = Math.max(worstResidual, Math.abs(residual));
        const step = Math.max(-1, Math.min(1, residual / curvature));
        gamma = Math.min(50, Math.max(1e-6, gamma * Math.exp(step)));
      }
    }

    if (worstResidual < tolerance) {
      converged = true;
      iterations++;
      break;
    }
  }

  if (!converged) warnings.push(`fit did not converge in ${maxIterations} iterations`);

  // --- Standard errors, from the inverse observed information ----------------
  //
  // The full matrix rather than just the diagonal: β_i and β_j for two presets
  // that played each other are strongly correlated (the likelihood only ever
  // sees their difference), so diagonal-only errors read narrower than the truth.
  const dim = free.length + (fitGamma ? 1 : 0);
  const info: number[][] = Array.from({ length: dim }, () => new Array<number>(dim).fill(0));
  const slot = new Map(free.map((p, k) => [p, k]));
  const thetaSlot = fitGamma ? free.length : -1;

  for (const p of pairs) {
    const s = halfRatio(betas[p.lo] - betas[p.hi]);
    const t = s + 1 / s + gamma;
    const shared = (p.n * (1 + (gamma * (s + 1 / s)) / 4)) / (t * t); // >0
    const kLo = slot.get(p.lo);
    const kHi = slot.get(p.hi);

    // Negated Hessian: +c^2*shared on the diagonal, -c^2*shared off it.
    if (kLo !== undefined) info[kLo][kLo] += C * C * shared;
    if (kHi !== undefined) info[kHi][kHi] += C * C * shared;
    if (kLo !== undefined && kHi !== undefined) {
      info[kLo][kHi] -= C * C * shared;
      info[kHi][kLo] -= C * C * shared;
    }

    if (thetaSlot >= 0) {
      const pDraw = gamma / t;
      info[thetaSlot][thetaSlot] += p.n * pDraw * (1 - pDraw);
      // Cross term: d2logL/dβ_lo dθ = -c * n * γ(1/s - s) / (2t^2), negated here.
      const cross = (C * p.n * gamma * (1 / s - s)) / (2 * t * t);
      if (kLo !== undefined) {
        info[kLo][thetaSlot] += cross;
        info[thetaSlot][kLo] += cross;
      }
      if (kHi !== undefined) {
        // Same pair seen from the other side flips the sign of (1/s - s).
        info[kHi][thetaSlot] -= cross;
        info[thetaSlot][kHi] -= cross;
      }
    }
  }

  const covariance = invert(info);
  if (!covariance) warnings.push("information matrix is singular — standard errors unavailable");

  const stderrFor = (preset: number): number | null => {
    const k = slot.get(preset);
    if (k === undefined || !covariance) return null;
    const variance = covariance[k][k];
    return variance > 0 ? Math.sqrt(variance) : null;
  };

  let drawParamStderr: number | null = null;
  if (fitGamma && covariance && thetaSlot >= 0) {
    const varTheta = covariance[thetaSlot][thetaSlot];
    // θ = ln γ, so by the delta method sd(γ) = γ·sd(θ).
    if (varTheta > 0) drawParamStderr = gamma * Math.sqrt(varTheta);
  }

  const ratings: RatingEstimate[] = presetIds.map((presetId, i) => {
    const views = viewsFor(allPairs, i);
    const played = views.reduce((sum, v) => sum + v.n, 0);
    const score = views.reduce((sum, v) => sum + v.score, 0);
    const isRateable = rateable.has(i);
    return {
      presetId,
      elo: isRateable ? betas[i] : anchorElo,
      stderr: i === anchor ? null : isRateable ? stderrFor(i) : null,
      games: played,
      score,
      anchor: i === anchor,
      rated: isRateable,
      note: isRateable
        ? i === anchor
          ? "anchor — fixed by definition, not measured"
          : undefined
        : played === 0
          ? "no games"
          : score === played
            ? `won all ${played} games — Elo is unbounded above, not measurable`
            : score === 0
              ? `lost all ${played} games — Elo is unbounded below, not measurable`
              : "no path of wins/draws connects it to the anchor",
    };
  });

  return {
    ratings,
    drawParam: gamma,
    drawParamStderr,
    converged,
    iterations,
    gamesUsed,
    warnings,
  };
}
