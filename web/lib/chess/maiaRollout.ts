import { Chess } from "chess.js";

import { evaluateMaiaBatch, sampleFromPolicy, uciToMove } from "./engineMaia";
import { describeEnd, type GameEndInfo } from "./gameLoop";
import type { EngineConfig } from "./types";

// Human-realistic win/draw/loss at a position: play the game out N times with
// Maia choosing every move for both sides, then count how they ended.
//
// The question this answers is not Stockfish's. A centipawn score says what
// happens under best play; this says what tends to happen when two players of a
// given rating play it out - which can be very different, because an easy-to-miss
// tactic is worth a lot of centipawns and much less against a human.
//
// Flat Monte Carlo, NOT MCTS: no tree, no node reuse, no UCB selection between
// rollouts. Every rollout is an independent sample from the root, which is the
// property that makes the proportion intervals below mean anything.
//
// See docs/specs/2026-08-05-maia-monte-carlo-rollouts.md.

/** Rollouts per estimate. See the cost note on `runMaiaRollouts`. */
export const DEFAULT_ROLLOUTS = 30;

/**
 * Sampling temperature. 1 is the distribution Maia was trained to match human
 * move frequencies with, so it's the principled default rather than a knob:
 * lower sharpens toward the argmax and shrinks the spread by suppressing real
 * behavioural variance, higher flattens toward random legal moves.
 */
export const DEFAULT_TEMPERATURE = 1;

/**
 * Hard cap on rollout length. Bounds a pathological shuffle - chess.js's own
 * fifty-move and repetition rules end most games long before this, and 120 plies
 * is 60 moves.
 */
export const DEFAULT_PLY_BUDGET = 120;

/** 95%. */
export const WILSON_Z = 1.96;

/**
 * Truncated fraction past which the interval stops being worth much. The spec
 * says "roughly 10-15%"; this takes the generous end and reports the fraction
 * either way, so the caller can show the number rather than trust the flag.
 */
export const TRUNCATION_ALARM = 0.15;

/**
 * What `logits_value` reads for an even game, measured rather than assumed:
 * -0.047 over four objectively level positions x all nine rating categories with
 * `elo_self == elo_oppo` (`web/scripts/probe-maia-graph.mjs`).
 *
 * The measurement that mattered here was the control. Sweeping `elo_self` with
 * `elo_oppo` pinned at 1500 moves this scalar by 0.88 (-0.242 at category 1 to
 * +0.636 at 9), which looks exactly like a rating-dependent bias that would need
 * a per-category centre. It isn't: with both inputs matched the same sweep is
 * flat to within 0.04. The model is pricing a rating *gap*, correctly, and that
 * is signal a rollout wants rather than bias to subtract - so one constant is
 * right, and a rollout at mismatched tiers gets the gap priced in for free.
 */
const VALUE_EVEN = -0.05;

/**
 * How much value separation counts as decisive. Deliberately wide: up a queen
 * measures +0.458 (0.51 above even), so a spread of 0.4 puts that at a 78%
 * expected score rather than a near-certain win, and nothing this side of mate
 * gets past ~95%.
 *
 * Wide because the head does not deserve better. It has the right sign but no
 * calibration, and it isn't even monotone - "about to be mated" reads -0.455,
 * *better* than "down a queen" at -0.566. A tighter spread would turn that
 * ordering error into confident nonsense.
 */
const VALUE_SPREAD = 0.4;

/**
 * Draw share at a dead-level truncation, tapering to zero at the extremes.
 *
 * A guess, and flagged as one. Half is defensible for the population this
 * applies to - a game still unresolved after 120 plies is by construction the
 * grindy, hard-to-convert kind - but nothing here measures it.
 */
const MAX_DRAW_SHARE = 0.5;

export type RolloutOutcome = "win" | "draw" | "loss";

export interface ProportionEstimate {
  count: number;
  proportion: number;
  /** Wilson score bounds, not Wald. See `wilsonInterval`. */
  low: number;
  high: number;
}

export interface MaiaRolloutResult {
  n: number;
  /**
   * Whose result "win" refers to: the side to move at the root. A rollout that
   * continues as the other colour has its chess.js `1-0`/`0-1` read from this
   * side's point of view, not white's.
   */
  rootTurn: "w" | "b";
  moverTier: number;
  opponentTier: number;
  temperature: number;
  win: ProportionEstimate;
  draw: ProportionEstimate;
  loss: ProportionEstimate;
  /** Rollouts that hit the ply budget and were bootstrapped off the value head. */
  truncated: number;
  truncatedFraction: number;
  /** `truncatedFraction` past `TRUNCATION_ALARM` - treat the interval as compromised. */
  compromised: boolean;
  /** How the rollouts ended, `ply-budget` counting the bootstrapped ones. */
  endReasons: Record<string, number>;
  meanPlies: number;
  longestPlies: number;
  /** `session.run()` calls made. Roughly plies-to-settle, not N x plies. */
  passes: number;
  elapsedMs: number;
}

export interface RolloutProgress {
  /** Rollouts that have reached a result. */
  settled: number;
  n: number;
  /** Plies played from the root so far. */
  ply: number;
}

export interface MaiaRolloutRequest {
  fen: string;
  /** Rating Maia plays the root side to move at. A real rating, not a category. */
  moverTier: number;
  /** Rating for the other side. Defaults to `moverTier` (self-play at one tier). */
  opponentTier?: number;
  n?: number;
  temperature?: number;
  plyBudget?: number;
  /** Injectable for reproducible verification runs. */
  rng?: () => number;
  signal?: AbortSignal;
  onProgress?: (progress: RolloutProgress) => void;
}

/** Thrown when `signal` aborts. Callers should swallow this, not surface it. */
export class RolloutAbortedError extends Error {
  constructor() {
    super("Rollouts aborted");
    this.name = "RolloutAbortedError";
  }
}

/**
 * Wilson score interval for a proportion, rather than the textbook Wald
 * `p ± z·√(p(1−p)/n)`.
 *
 * Wald collapses to zero width at p̂ = 0 or 1 — it would report 30/30 wins as
 * "100% to 100%", which is exactly the case this feature runs into most (any
 * position with a forced tactic). Wilson gives [88.6%, 100%] there. Away from the
 * extremes the two agree to about a point.
 */
export function wilsonInterval(count: number, n: number, z = WILSON_Z): ProportionEstimate {
  if (n <= 0) return { count, proportion: 0, low: 0, high: 1 };

  const proportion = count / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (proportion + z2 / (2 * n)) / denominator;
  const halfWidth = (z * Math.sqrt((proportion * (1 - proportion)) / n + z2 / (4 * n * n))) / denominator;

  return {
    count,
    proportion,
    low: Math.max(0, centre - halfWidth),
    high: Math.min(1, centre + halfWidth),
  };
}

/**
 * `logits_value` -> expected score in [0,1] for whoever is to move.
 *
 * Exported so the verification page can check the mapping's shape directly
 * instead of inferring it from rollout counts.
 */
export function valueToExpectedScore(value: number): number {
  return 1 / (1 + Math.exp(-(value - VALUE_EVEN) / VALUE_SPREAD));
}

/**
 * Turns a truncated rollout into one of the three outcomes.
 *
 * Bootstrapping rather than discarding, because discarding is not neutral: the
 * rollouts that run past 120 plies are precisely the drawish, hard-to-convert
 * ones, so dropping them strips draws out of the sample and skews the whole
 * estimate decisive.
 *
 * It *samples* the outcome instead of adding fractions of a game to each bucket.
 * Two reasons: the counts stay integers, so the Wilson intervals keep meaning
 * "N independent draws"; and the extra variance from not knowing how these games
 * would have ended shows up as a wider interval rather than being hidden inside
 * a confident-looking fractional count.
 */
function bootstrapOutcome(scoreForRoot: number, rng: () => number): RolloutOutcome {
  const draw = MAX_DRAW_SHARE * (1 - Math.abs(2 * scoreForRoot - 1));
  const win = Math.max(0, scoreForRoot - draw / 2);

  const roll = rng();
  if (roll < win) return "win";
  if (roll < win + draw) return "draw";
  return "loss";
}

/** chess.js's result, read from the root mover's point of view. */
function outcomeFor(result: GameEndInfo["result"], rootTurn: "w" | "b"): RolloutOutcome {
  if (result === "1/2-1/2") return "draw";
  const whiteWon = result === "1-0";
  return whiteWon === (rootTurn === "w") ? "win" : "loss";
}

function maiaConfig(ratingTier: number): EngineConfig {
  return { type: "maia", label: `Maia ${ratingTier}`, ratingTier };
}

function pickRandomLegal(game: Chess, rng: () => number) {
  const legal = game.moves({ verbose: true });
  const index = Math.min(legal.length - 1, Math.floor(rng() * legal.length));
  return legal[index];
}

/** Advances one rollout by a ply. chess.js stays the authority on what's legal. */
function playOnePly(
  game: Chess,
  policy: { uci: string; probability: number }[],
  temperature: number,
  rng: () => number,
): void {
  if (policy.length > 0) {
    const uci = sampleFromPolicy(policy, temperature, rng);
    try {
      game.move(uciToMove(uci));
      return;
    } catch {
      // Same defensive fallback as the live game loop: a move outside
      // chess.moves() costs this rollout one random legal move rather than
      // ending the whole batch. Reachable if a legal move is missing from Maia's
      // index table, which is the only way the decode can hand back a move
      // chess.js won't take.
      console.warn(`Rollout got an unplayable move ${uci} - playing a random legal move`);
    }
  }
  const fallback = pickRandomLegal(game, rng);
  game.move({ from: fallback.from, to: fallback.to, promotion: fallback.promotion });
}

/** Lets the browser paint between passes. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Plays the position out `n` times and reports how it went for the side to move.
 *
 * Cost, measured rather than hoped for: about 25ms per position per ply,
 * whatever the batch size (`web/scripts/probe-maia-graph.mjs` - this backend gets
 * roughly 10% from batching, not a multiple). So the bill is
 * `Σ rollout lengths x ~25ms`: around 30s for N=30 from a middlegame, minutes at
 * N=100. It is an on-demand action for that reason, never something to run per
 * ply of a live game.
 *
 * Two consequences worth knowing before calling it:
 *
 *  - **It blocks the main thread in bursts.** There is no Worker around Maia
 *    (unlike Stockfish), so each pass is single-threaded wasm running
 *    synchronously - a few hundred ms at a time, once per ply. It yields between
 *    passes so progress can paint, which does not make the bursts themselves
 *    disappear. A worker pool is the real fix and is out of this feature's scope.
 *  - **`signal` is checked between passes, not inside one.** Aborting waits for
 *    the pass in flight to finish; `session.run()` isn't interruptible.
 *
 * Unlike the spec's fixed `[N,...]` tensor, finished rollouts are dropped from
 * the batch rather than resubmitting their last position with the output
 * discarded. The spec avoided that only because compacting reopened the
 * dynamic-batch-size question - which the probe has since answered (the axis is
 * declared `batch_size` and varying it mid-session is fine), so the reason not to
 * is gone. It matters: with FLOPs conserved, padding dead rows would have cost
 * real time, roughly double from a position where half the rollouts finish early.
 */
export async function runMaiaRollouts({
  fen,
  moverTier,
  opponentTier = moverTier,
  n = DEFAULT_ROLLOUTS,
  temperature = DEFAULT_TEMPERATURE,
  plyBudget = DEFAULT_PLY_BUDGET,
  rng = Math.random,
  signal,
  onProgress,
}: MaiaRolloutRequest): Promise<MaiaRolloutResult> {
  if (n < 1) throw new Error(`runMaiaRollouts needs at least one rollout, got ${n}`);

  const startedAt = performance.now();

  // Throws on a malformed FEN, which is the right place for that to happen.
  const root = new Chess(fen);
  if (root.isGameOver()) {
    throw new Error("Nothing to roll out - the position is already over");
  }
  const rootTurn = root.turn();

  const games = Array.from({ length: n }, () => new Chess(fen));
  const outcomes: (RolloutOutcome | null)[] = Array.from({ length: n }, () => null);
  const lengths = Array.from({ length: n }, () => 0);
  const endReasons: Record<string, number> = {};

  const moverConfig = maiaConfig(moverTier);
  const opponentConfig = maiaConfig(opponentTier);

  let passes = 0;
  let settled = 0;

  for (let ply = 0; ply < plyBudget; ply++) {
    if (signal?.aborted) throw new RolloutAbortedError();

    const alive: number[] = [];
    for (let i = 0; i < n; i++) if (outcomes[i] === null) alive.push(i);
    if (alive.length === 0) break;

    // Every alive rollout is the same number of plies from the root, so they all
    // have the same side to move - but this reads it per row rather than
    // assuming, since that invariant is easy to break later and silently.
    const evaluations = await evaluateMaiaBatch(
      alive.map((i) => {
        const rootSideMoving = games[i].turn() === rootTurn;
        return {
          fen: games[i].fen(),
          config: rootSideMoving ? moverConfig : opponentConfig,
          oppoRatingTier: rootSideMoving ? opponentTier : moverTier,
        };
      }),
    );
    passes += 1;

    alive.forEach((i, row) => {
      const game = games[i];
      playOnePly(game, evaluations[row].policy, temperature, rng);
      lengths[i] += 1;

      if (game.isGameOver()) {
        const end = describeEnd(game);
        outcomes[i] = outcomeFor(end.result, rootTurn);
        endReasons[end.endReason] = (endReasons[end.endReason] ?? 0) + 1;
        settled += 1;
      }
    });

    onProgress?.({ settled, n, ply: ply + 1 });
    await yieldToEventLoop();
  }

  // ── Whatever is still running hit the ply budget ────────────────────────────
  const truncatedRows: number[] = [];
  for (let i = 0; i < n; i++) if (outcomes[i] === null) truncatedRows.push(i);

  if (truncatedRows.length > 0) {
    const evaluations = await evaluateMaiaBatch(
      truncatedRows.map((i) => {
        const rootSideMoving = games[i].turn() === rootTurn;
        return {
          fen: games[i].fen(),
          config: rootSideMoving ? moverConfig : opponentConfig,
          oppoRatingTier: rootSideMoving ? opponentTier : moverTier,
        };
      }),
    );
    passes += 1;

    truncatedRows.forEach((i, row) => {
      // The value head speaks for whoever is to move at that final position, so
      // it needs flipping when that isn't the root side. This is the sign bug the
      // mate-in-1 verification exists to catch.
      const scoreForMover = valueToExpectedScore(evaluations[row].value);
      const rootSideMoving = games[i].turn() === rootTurn;
      const scoreForRoot = rootSideMoving ? scoreForMover : 1 - scoreForMover;

      outcomes[i] = bootstrapOutcome(scoreForRoot, rng);
      endReasons["ply-budget"] = (endReasons["ply-budget"] ?? 0) + 1;
    });
  }

  const counts = { win: 0, draw: 0, loss: 0 };
  for (const outcome of outcomes) if (outcome) counts[outcome] += 1;

  const truncated = truncatedRows.length;
  return {
    n,
    rootTurn,
    moverTier,
    opponentTier,
    temperature,
    win: wilsonInterval(counts.win, n),
    draw: wilsonInterval(counts.draw, n),
    loss: wilsonInterval(counts.loss, n),
    truncated,
    truncatedFraction: truncated / n,
    compromised: truncated / n > TRUNCATION_ALARM,
    endReasons,
    meanPlies: lengths.reduce((a, b) => a + b, 0) / n,
    longestPlies: Math.max(...lengths),
    passes,
    elapsedMs: performance.now() - startedAt,
  };
}
