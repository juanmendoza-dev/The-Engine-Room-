// The one probability model shared by the rating fit and the sequential test.
//
// Both `ratingBT.ts` and `sprt.ts` import from here on purpose: fishtest fits its
// nuisance parameters and runs its stopping rule under a single model, and doing
// it under two would mean a rating gap that the SPRT would not have stopped on.
//
// Spec: docs/specs/2026-08-05-sprt-engine-ratings.md ("Rating math", "SPRT")

import type { GameOutcome } from "./types";

/**
 * Deltas past this are numerically pointless (10^(4000/800) = 10^5 already puts
 * the loss probability at 1e-10) and only risk overflow further downstream.
 */
const MAX_DELTA = 4000;

/**
 * Probabilities below this get floored before any log is taken. Without it a
 * `gamma` of exactly 0 makes P(draw) exactly 0, and a single drawn game then
 * poisons the whole running LLR with -Infinity or NaN — the spec's own
 * "degenerate probabilities" error case.
 */
export const PROB_FLOOR = 1e-12;

/**
 * s = 10^(delta/800), the *square root* of the usual Elo strength ratio.
 *
 * Working in the half-exponent is not a micro-optimisation. Davidson's tie term
 * is γ·√(π_i·π_j), so every formula below wants the square root anyway, and
 * writing it this way means the pair only ever needs `s` and `1/s` — the
 * absolute strengths cancel, which is exactly the invariance the model has.
 * It also keeps the arithmetic inside doubles at any Elo the app can produce.
 */
export function halfRatio(delta: number): number {
  const d = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, delta));
  return Math.pow(10, d / 800);
}

export interface OutcomeProbs {
  pWin: number;
  pDraw: number;
  pLoss: number;
}

/**
 * Davidson (1970), "On extending the Bradley-Terry model to accommodate ties in
 * paired comparisons". With π_i = 10^(β_i/400) and one shared tie parameter γ≥0:
 *
 *   P(i beats j) = π_i / (π_i + π_j + γ√(π_iπ_j))
 *   P(draw)      = γ√(π_iπ_j) / (same)
 *
 * Divided through by √(π_iπ_j) that is s / (s + 1/s + γ) and γ / (s + 1/s + γ),
 * which is what this actually computes. `gamma = 0` recovers plain Bradley-Terry
 * (the ordinary Elo expected-score curve) with no draws at all.
 *
 * `delta` is Elo of the reference side minus its opponent, and the returned
 * probabilities are from that same reference side.
 */
export function davidsonProbs(delta: number, gamma: number): OutcomeProbs {
  const s = halfRatio(delta);
  const g = Math.max(0, gamma);
  const total = s + 1 / s + g;
  return { pWin: s / total, pDraw: g / total, pLoss: 1 / s / total };
}

/** Wins plus half the draws — what a rating fit is actually trying to explain. */
export function expectedScore(delta: number, gamma: number): number {
  const { pWin, pDraw } = davidsonProbs(delta, gamma);
  return pWin + pDraw / 2;
}

export function probOf(probs: OutcomeProbs, outcome: GameOutcome): number {
  if (outcome === "win") return probs.pWin;
  if (outcome === "draw") return probs.pDraw;
  return probs.pLoss;
}

/**
 * One game's log-likelihood-ratio increment, Z = ln(P_H1(R)/P_H0(R)).
 *
 * Both probabilities are floored (see `PROB_FLOOR`) before the division. The
 * floor is a guard against a degenerate model, not a modelling choice: at any
 * γ>0 every outcome has positive probability under both hypotheses and the floor
 * never binds.
 */
export function llrIncrement(
  outcome: GameOutcome,
  elo0: number,
  elo1: number,
  gamma: number,
): number {
  const p1 = Math.max(PROB_FLOOR, probOf(davidsonProbs(elo1, gamma), outcome));
  const p0 = Math.max(PROB_FLOOR, probOf(davidsonProbs(elo0, gamma), outcome));
  return Math.log(p1 / p0);
}

/**
 * Expected LLR per game under whichever hypothesis is true — the KL divergence
 * between the two outcome distributions, in nats. This is the quantity that sets
 * how many games a decision costs, and it falls off roughly quadratically as the
 * gap between elo0 and elo1 narrows: closing from a 200-point question to a
 * 50-point one is ~14x the games, not 4x.
 *
 * `deltaTrue` is the gap actually in force, normally elo1 (for E₁[Z]) or elo0
 * (for E₀[Z]).
 */
export function expectedLlrPerGame(
  deltaTrue: number,
  elo0: number,
  elo1: number,
  gamma: number,
): number {
  const truth = davidsonProbs(deltaTrue, gamma);
  return (
    truth.pWin * llrIncrement("win", elo0, elo1, gamma) +
    truth.pDraw * llrIncrement("draw", elo0, elo1, gamma) +
    truth.pLoss * llrIncrement("loss", elo0, elo1, gamma)
  );
}

/**
 * Wald's approximation for how many games a decision takes, ignoring boundary
 * overshoot (so it reads a little low). Both directions, because a run that is
 * going to accept H0 costs a different number of games than one accepting H1.
 */
export function expectedGamesToDecision(
  elo0: number,
  elo1: number,
  alpha: number,
  beta: number,
  gamma: number,
): { underH0: number; underH1: number } {
  const A = Math.log((1 - beta) / alpha);
  const B = Math.log(beta / (1 - alpha));
  const e1 = expectedLlrPerGame(elo1, elo0, elo1, gamma);
  const e0 = expectedLlrPerGame(elo0, elo0, elo1, gamma);
  return {
    underH1: ((1 - beta) * A + beta * B) / e1,
    underH0: (alpha * A + (1 - alpha) * B) / e0,
  };
}
