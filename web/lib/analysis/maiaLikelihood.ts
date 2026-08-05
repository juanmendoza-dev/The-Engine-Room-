import { eloToCategory, evaluateMaiaAt, type MaiaEvaluation } from "@/lib/chess/engineMaia";

// The likelihood half of the rating estimator: given a position, what does each
// of Maia's rating buckets think of the moves available? Nothing here knows
// about posteriors or games — it's the per-position primitive the accumulator in
// ratingPosterior.ts folds over.
//
// Read `getMaiaMove` backwards and you have this feature: that fixes elo_self
// and searches over moves, this fixes the move and searches over elo_self. Same
// P(move | position, elo_self, elo_oppo) either way.
//
// See docs/specs/2026-08-05-bayesian-rating-inference.md.

/**
 * The 9 named tiers, as ratings. These are `eloToCategory()` categories 1-9;
 * category 0 ("below 1100") and 10 ("2000 and up") are deliberately outside the
 * prior's support because neither is a bucket the model was given a name for.
 *
 * Two scales meet in this file and mixing them up is the easy bug here: a
 * *bucket* is a rating (1100-1900), a *category* is the model's tensor input
 * (1-9). `eloToCategory` converts, and this module is the only place that does.
 */
export const MAIA_RATING_BUCKETS = [
  1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900,
] as const;

export type RatingBucket = (typeof MAIA_RATING_BUCKETS)[number];

/**
 * Hand the main thread back between forward passes.
 *
 * Maia's ONNX session is single-threaded wasm on the main JS thread — there is
 * no Worker for it, unlike Stockfish. Nine `session.run()` calls back to back
 * hold that thread for ~400ms, which is long enough to stall React and the
 * opponent engine both. A macrotask between each one doesn't make the work
 * cheaper, it just stops it monopolising the frame.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * One forward pass per bucket at the same position, `oppoBucket` held fixed
 * across all nine — it isn't a hypothesis being tested, it's the opponent who
 * is actually sitting there.
 *
 * Costs ~400ms (9 x ~35-55ms) and must stay off the move-response path.
 * Index-aligned with MAIA_RATING_BUCKETS.
 */
export async function policiesForAllBuckets(
  fen: string,
  oppoBucket: RatingBucket,
): Promise<MaiaEvaluation[]> {
  const oppoCategory = eloToCategory(oppoBucket);

  // Sequential on purpose. Whether concurrent session.run() calls on one ORT
  // session interleave safely is unverified, and a wrong answer there is a
  // corrupted read rather than a clean error — so this awaits each pass.
  const policies: MaiaEvaluation[] = [];
  for (const bucket of MAIA_RATING_BUCKETS) {
    if (policies.length > 0) await yieldToEventLoop();
    policies.push(await evaluateMaiaAt(fen, eloToCategory(bucket), oppoCategory));
  }
  return policies;
}

/**
 * L_t(r) for each bucket: how likely each bucket was to play the move that got
 * played. `playedUci` is chess.js's `lan` — real board coordinates, which is
 * also what `MaiaEvaluation.policy` reports (evaluateMaia mirrors black-to-move
 * moves back before returning), so no mirroring belongs here.
 *
 * Zero means "this bucket gave that move no mass", which in practice means the
 * move is missing from Maia's index table entirely — the caller decides what to
 * do about it, since flooring to epsilon and skipping the ply are very
 * different things.
 */
export function likelihoodsForMove(policies: MaiaEvaluation[], playedUci: string): number[] {
  return policies.map(
    (evaluation) => evaluation.policy.find((move) => move.uci === playedUci)?.probability ?? 0,
  );
}

/**
 * I(fen) in nats: the mutual information between "which bucket" and "which
 * move" at this position, under `posterior` as the weight on each bucket.
 *
 * Free from the same 9 policies the likelihood step already computed — this is
 * arithmetic, not a 10th forward pass. It answers "is this position even
 * capable of telling the buckets apart", which is what stops a book move where
 * every bucket plays the same thing from counting as evidence.
 *
 * The one-legal-move case needs no special branch: a softmax over a single
 * logit is 1 whatever the logit was, so every bucket and the mixture all agree
 * at 1, every log(1/1) is 0, and this returns exactly 0.
 */
export function moveMutualInformation(policies: MaiaEvaluation[], posterior: number[]): number {
  if (policies.length === 0) return 0;

  // Every policy is for the same FEN so the move sets match; collecting the
  // union rather than trusting that is cheap insurance against a bucket whose
  // move dropped out of the index table.
  const perMove = new Map<string, number[]>();
  policies.forEach((evaluation, bucket) => {
    for (const { uci, probability } of evaluation.policy) {
      let byBucket = perMove.get(uci);
      if (!byBucket) {
        byBucket = new Array<number>(policies.length).fill(0);
        perMove.set(uci, byBucket);
      }
      byBucket[bucket] = probability;
    }
  });

  // Sum over moves on the outside, buckets inside — the spec writes it the
  // other way round, which is the same sum reordered.
  let information = 0;
  for (const byBucket of perMove.values()) {
    let mixture = 0;
    for (let bucket = 0; bucket < policies.length; bucket++) {
      mixture += posterior[bucket] * byBucket[bucket];
    }
    if (mixture <= 0) continue;

    for (let bucket = 0; bucket < policies.length; bucket++) {
      const probability = byBucket[bucket];
      if (probability <= 0) continue;
      information += posterior[bucket] * probability * Math.log(probability / mixture);
    }
  }

  // A posterior-weighted KL to the mixture is non-negative analytically; float
  // error can still land it a hair under zero at I=0 positions.
  return Math.max(0, information);
}
