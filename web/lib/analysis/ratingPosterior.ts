import type { EngineConfig } from "@/lib/chess/types";

import {
  likelihoodsForMove,
  MAIA_RATING_BUCKETS,
  moveMutualInformation,
  policiesForAllBuckets,
  type RatingBucket,
} from "./maiaLikelihood";

// Accumulates the player's own moves into a posterior over Maia's 9 rating
// buckets. One number per bucket, updated a ply at a time, normalised only when
// somebody reads it.
//
// What this measures, stated honestly: which bucket's *move distribution* the
// player resembles. That correlates with rating, it isn't identical to it — an
// unusual-but-strong repertoire reads as a worse fit than plain strength would.
//
// See docs/specs/2026-08-05-bayesian-rating-inference.md.

/**
 * Tempering exponent (tau). Discounts every ply's evidence uniformly, because
 * the model underneath treats 20-30 correlated moves from one game as
 * independent draws and they very much aren't — a player in book plays five
 * theory moves for one shared reason, not five independent re-rolls of "do I
 * look like a 1500".
 *
 * The failure it prevents is one of magnitude, not direction: untempered, the
 * posterior narrows as if it had seen 25 independent trials when it saw maybe
 * 8, and the interval claims a precision the evidence can't support.
 *
 * Kept at the spec's proposed 0.35, but the justification changed once it was
 * measured, and the honest version is weaker than the spec's: the
 * overconfidence tau exists to prevent does not happen on this data. At tau=1
 * with every ply at full weight, 40 rated plies of Maia's own moves put at most
 * 25.9% on a single bucket and never crossed 90% — nine hypotheses this similar
 * to each other cannot collapse, whatever the independence assumption says.
 *
 * So tau is cheap insurance rather than a load-bearing correction. What it
 * actually buys, measured on the verification fixture, is one bucket of extra
 * interval width (1400-1800 at tau=1 against 1400-1900 at 0.35) for no change
 * in MAP — erring wide, which is the direction this app errs in on purpose.
 * See docs/plans/2026-08-03-engine-room-implementation.md, Task 13.
 */
export const TEMPERING_EXPONENT = 0.35;

/** Floors log(0) when the played move is one no bucket liked. */
export const LIKELIHOOD_FLOOR = 1e-6;

/**
 * Below this much mutual information a ply is skipped outright — the buckets
 * agree here, so folding it in is drag rather than evidence. Sits just under the
 * observed first quartile (0.011 nats across the verification game). Positions
 * with a single legal move land at exactly 0 and are covered without a branch.
 */
export const MIN_INFORMATION_NATS = 0.01;

/**
 * Mutual information that earns a ply full weight; below it the weight scales
 * linearly.
 *
 * Measured, and the measurement mattered more than anything else in this file.
 * The spec's starting guesses (I_min 0.02, I_ref 0.25) were an order of
 * magnitude out in *units*, not just in value: real I(fen) over a 40-ply game
 * runs min 0.002, median 0.016, p75 0.034, max 0.086 nats. At the spec's numbers
 * 22 of 40 plies were skipped outright, not one reached full weight, mean g_t
 * was 0.07, and the posterior finished 0.8 points off a flat prior — the
 * estimator read as broken when it was being told to ignore its own evidence.
 *
 * 0.03 is roughly the 75th percentile of observed I, so the most discriminating
 * quarter of plies count fully and a median ply counts about half.
 */
export const REFERENCE_INFORMATION_NATS = 0.03;

/** Mass the credible interval reaches for before it stops widening. */
export const CREDIBLE_MASS = 0.8;

/**
 * Effective plies before the readout is allowed to name a bucket at all.
 *
 * This gate is the whole reason the feature can be shown to anyone. The header
 * badge this app retired said "Live - engines coupled" over nothing of the kind,
 * and the lesson recorded in docs/design/ink-and-bone-notes.md is that the badge
 * wasn't ugly, it was untrue. A bare "you play like a 1400" on ply 2 is the same
 * mistake with better arithmetic behind it.
 *
 * 6 rather than the spec's suggested 3, and the criterion is MAP stability, not
 * interval width. On the verification fixture the MAP swings 1900 -> 1400 ->
 * 1600 across the first six rated plies — most of the width of the scale, on
 * almost no evidence. At 3 effective plies (rated ply 5 there) the readout would
 * appear and then contradict itself twice. From ~6 it holds one bucket for the
 * rest of the game, and the band is still visibly shrinking after it, which is
 * what the spec asks the UI to show. Costs about ten of the player's own moves
 * before anything appears; the placeholder covers that honestly.
 */
export const READY_EFFECTIVE_PLIES = 6;

export interface RatingEstimatorState {
  /** Unnormalised log-posterior, index-aligned with MAIA_RATING_BUCKETS. */
  logPosterior: number[];
  oppoBucket: RatingBucket;
  /** Sum of g_t — the information actually gathered, not the plies played. */
  effectivePlies: number;
  totalPlies: number;
}

export interface RatingReport {
  probabilities: number[];
  mapBucket: RatingBucket;
  credibleInterval: { low: RatingBucket; high: RatingBucket; coverage: number };
  effectivePlies: number;
  totalPlies: number;
  /** Past the display gate. False means the UI must not name a bucket. */
  ready: boolean;
}

function nearestBucket(rating: number): RatingBucket {
  let nearest: RatingBucket = MAIA_RATING_BUCKETS[0];
  let smallestGap = Infinity;
  for (const bucket of MAIA_RATING_BUCKETS) {
    const gap = Math.abs(bucket - rating);
    if (gap < smallestGap) {
      smallestGap = gap;
      nearest = bucket;
    }
  }
  return nearest;
}

/**
 * Which bucket to pin `elo_oppo` to. Fixed rather than marginalised: averaging
 * over the opponent's rating too would be 81 forward passes a ply (~3-4.5s)
 * instead of 9, for a parameter that is plausibly second-order.
 *
 * - Maia opponent: its `ratingTier` is already one of the 9, exactly.
 * - Stockfish: its `UCI_Elo` is a different scale with no principled conversion
 *   to Maia's human-imitation buckets, so it gets rounded to the nearest one.
 *   1320 -> 1300 and 1800 -> 1800 are fair; 2800 -> 1900 is a real
 *   approximation, because Maia's scale simply doesn't reach 2800.
 * - Anything with no rating at all, including a `human` config: 1500.
 */
export function resolveOppoBucket(opponent: EngineConfig): RatingBucket {
  const rating = opponent.type === "maia" ? opponent.ratingTier : opponent.elo;
  return rating === undefined ? 1500 : nearestBucket(rating);
}

export function createRatingEstimator(oppoBucket: RatingBucket): RatingEstimatorState {
  // Flat prior. An informative one centred on 1500 converges faster, at the
  // price of the app assuming every new player is average before it has seen a
  // single move.
  const flat = -Math.log(MAIA_RATING_BUCKETS.length);
  return {
    logPosterior: MAIA_RATING_BUCKETS.map(() => flat),
    oppoBucket,
    effectivePlies: 0,
    totalPlies: 0,
  };
}

/** Subtract-the-max before exp, same guard evaluateMaia uses on its own softmax. */
function normalize(logPosterior: number[]): number[] {
  const max = Math.max(...logPosterior);
  const exponentiated = logPosterior.map((value) => Math.exp(value - max));
  const total = exponentiated.reduce((a, b) => a + b, 0);
  return exponentiated.map((value) => value / total);
}

/** g_t: 0 below the floor, ramping linearly to full weight at the reference. */
export function informationWeight(informationNats: number): number {
  if (informationNats < MIN_INFORMATION_NATS) return 0;
  return Math.min(1, informationNats / REFERENCE_INFORMATION_NATS);
}

/**
 * Folds one of the player's own moves in and returns fresh state — never
 * mutates, so a stale update landing late can't corrupt a newer posterior.
 *
 * `fenBefore`/`playedUci` come straight off chess.js:
 * `game.history({ verbose: true }).at(-1)!.before` and `.lan`.
 *
 * Runs up to 9 forward passes, so keep it off the move-response path: fire it
 * after the move is already committed to state, not awaited inside onPieceDrop.
 */
export async function updateRatingEstimator(
  state: RatingEstimatorState,
  fenBefore: string,
  playedUci: string,
): Promise<RatingEstimatorState> {
  const policies = await policiesForAllBuckets(fenBefore, state.oppoBucket);
  const likelihoods = likelihoodsForMove(policies, playedUci);

  // Weighted under the posterior as it stands *before* this ply, so a move
  // never gets to decide how much it counts for.
  const prior = normalize(state.logPosterior);
  const information = moveMutualInformation(policies, prior);

  // A move no bucket scored at all is one that's missing from Maia's index
  // table, not one every bucket found surprising. Flooring all nine to epsilon
  // would leave the normalised posterior untouched while still advancing
  // effectivePlies — a display gate creeping forward on zero evidence. Skip it.
  const scored = likelihoods.some((likelihood) => likelihood > 0);
  const weight = scored ? informationWeight(information) : 0;

  // A zero weight is a no-op update rather than a branch around the maths, but
  // there's no point running the arithmetic to add zero.
  if (weight === 0) {
    return { ...state, totalPlies: state.totalPlies + 1 };
  }

  const beta = TEMPERING_EXPONENT * weight;
  return {
    logPosterior: state.logPosterior.map(
      (logProbability, bucket) =>
        logProbability + beta * Math.log(Math.max(likelihoods[bucket], LIKELIHOOD_FLOOR)),
    ),
    oppoBucket: state.oppoBucket,
    effectivePlies: state.effectivePlies + weight,
    totalPlies: state.totalPlies + 1,
  };
}

export function summarizePosterior(state: RatingEstimatorState): RatingReport {
  const probabilities = normalize(state.logPosterior);

  let mapIndex = 0;
  for (let i = 1; i < probabilities.length; i++) {
    if (probabilities[i] > probabilities[mapIndex]) mapIndex = i;
  }

  // Contiguous by construction, so it reads as a band ("1300-1700") rather than
  // a set of buckets. Assumes a roughly unimodal posterior; a genuinely bimodal
  // one gets papered into one span, which is worth knowing and not worth fixing
  // here — no real game produces one.
  let low = mapIndex;
  let high = mapIndex;
  let mass = probabilities[mapIndex];
  while (mass < CREDIBLE_MASS && (low > 0 || high < probabilities.length - 1)) {
    const below = low > 0 ? probabilities[low - 1] : -1;
    const above = high < probabilities.length - 1 ? probabilities[high + 1] : -1;
    if (above > below) {
      high += 1;
      mass += probabilities[high];
    } else {
      low -= 1;
      mass += probabilities[low];
    }
  }

  return {
    probabilities,
    mapBucket: MAIA_RATING_BUCKETS[mapIndex],
    credibleInterval: {
      low: MAIA_RATING_BUCKETS[low],
      high: MAIA_RATING_BUCKETS[high],
      coverage: mass,
    },
    effectivePlies: state.effectivePlies,
    totalPlies: state.totalPlies,
    ready: state.effectivePlies >= READY_EFFECTIVE_PLIES,
  };
}
