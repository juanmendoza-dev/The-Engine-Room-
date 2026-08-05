// Glicko-2, per Glickman's worked example (glicko.net/glicko/glicko2.pdf).
//
// Secondary to `ratingBT.ts`, not a replacement for it. The reason it's here at
// all is presentational: "Stockfish 1320: 1290 ± 45" is a friendlier thing to put
// in front of a reader than a Bradley-Terry covariance matrix, and RD carries
// that interval around with the rating instead of in a separate structure.
//
// The caveat, stated up front rather than discovered later: Glicko-2 is built for
// sparse asynchronous ladders where real skill drifts over time. Our presets are
// frozen software and the schedule is dense, so the volatility term has nothing
// to track — expect σ to walk down to its floor and sit there. That is the model
// behaving correctly on a design it wasn't written for, not a bug to chase.

/** Glickman's conversion constant between the 1500-centred scale and his own. */
const SCALE = 173.7178;

/** Convergence tolerance for the volatility solve, from the paper. */
const EPSILON = 1e-6;

export interface Glicko2Rating {
  /** On the familiar scale (1500-centred), not Glickman's internal one. */
  rating: number;
  /** Rating deviation, same scale. Roughly one standard error. */
  rd: number;
  volatility: number;
}

export interface Glicko2Game {
  opponent: Glicko2Rating;
  /** 1 win, 0.5 draw, 0 loss. */
  score: number;
}

/** The paper's suggested starting point for an unrated player. */
export const DEFAULT_GLICKO2: Glicko2Rating = { rating: 1500, rd: 350, volatility: 0.06 };

/**
 * System constant. Glickman suggests 0.3–1.2: smaller constrains volatility
 * changes, which suits opponents that genuinely cannot improve between games.
 */
export const DEFAULT_TAU = 0.5;

function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

function expectedScore(mu: number, muJ: number, phiJ: number): number {
  return 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));
}

/**
 * Solve for the new volatility with the Illinois variant of regula falsi, as the
 * paper specifies. It is worth using the exact algorithm given rather than a
 * generic root finder: `f` is steep near the answer and plain regula falsi
 * stalls on one endpoint, which shows up as a volatility that never moves.
 */
function solveVolatility(sigma: number, phi: number, v: number, delta: number, tau: number): number {
  const a = Math.log(sigma * sigma);
  const deltaSq = delta * delta;
  const phiSq = phi * phi;

  const f = (x: number): number => {
    const ex = Math.exp(x);
    const denom = phiSq + v + ex;
    return (ex * (deltaSq - phiSq - v - ex)) / (2 * denom * denom) - (x - a) / (tau * tau);
  };

  let A = a;
  let B: number;
  if (deltaSq > phiSq + v) {
    B = Math.log(deltaSq - phiSq - v);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0 && k < 1000) k++;
    B = a - k * tau;
  }

  let fA = f(A);
  let fB = f(B);
  let guard = 0;
  while (Math.abs(B - A) > EPSILON && guard++ < 1000) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    B = C;
    fB = fC;
  }

  return Math.exp(A / 2);
}

/**
 * One rating period's update. `games` are every game this preset played in the
 * period, against opponents at *their* ratings as of the period's start — not
 * updated mid-period, which is the whole point of a period.
 *
 * A period with no games still widens RD: uncertainty grows while nothing is
 * observed. That branch matters more than it looks, because it is the only place
 * Glicko-2 differs qualitatively from "an Elo update with error bars".
 */
export function updateGlicko2(
  current: Glicko2Rating,
  games: Glicko2Game[],
  tau: number = DEFAULT_TAU,
): Glicko2Rating {
  const mu = (current.rating - 1500) / SCALE;
  const phi = current.rd / SCALE;
  const sigma = current.volatility;

  if (games.length === 0) {
    const phiPrime = Math.sqrt(phi * phi + sigma * sigma);
    return { rating: current.rating, rd: phiPrime * SCALE, volatility: sigma };
  }

  let invV = 0;
  let deltaSum = 0;
  for (const game of games) {
    const muJ = (game.opponent.rating - 1500) / SCALE;
    const phiJ = game.opponent.rd / SCALE;
    const gJ = g(phiJ);
    const eJ = expectedScore(mu, muJ, phiJ);
    invV += gJ * gJ * eJ * (1 - eJ);
    deltaSum += gJ * (game.score - eJ);
  }

  // Every opponent identical and the outcome a foregone conclusion drives
  // E(1-E) to zero and v to infinity. Bail rather than emit NaN.
  if (invV <= 0) {
    const phiPrime = Math.sqrt(phi * phi + sigma * sigma);
    return { rating: current.rating, rd: phiPrime * SCALE, volatility: sigma };
  }

  const v = 1 / invV;
  const delta = v * deltaSum;

  const sigmaPrime = solveVolatility(sigma, phi, v, delta, tau);
  const phiStar = Math.sqrt(phi * phi + sigmaPrime * sigmaPrime);
  const phiPrime = 1 / Math.sqrt(1 / (phiStar * phiStar) + invV);
  const muPrime = mu + phiPrime * phiPrime * deltaSum;

  return {
    rating: muPrime * SCALE + 1500,
    rd: phiPrime * SCALE,
    volatility: sigmaPrime,
  };
}
