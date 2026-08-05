// Shared shapes for the SPRT / empirical-rating machinery (Task 16).
//
// Deliberately zero runtime dependency — not chess.js, not React, nothing. That
// is what lets `scripts/verify-analysis-math.mjs` import the maths modules under
// plain Node and check them without a browser or an engine. The one module in
// this family that *does* need a browser is `matchRunner.ts`, and it is the only
// one the verify script never touches.
//
// Spec: docs/specs/2026-08-05-sprt-engine-ratings.md

/**
 * One entry from the randomized opening book. The runner replays `san` through
 * chess.js before either engine is consulted, so a typo throws at the first game
 * rather than quietly producing a different opening than the one it's labelled.
 *
 * Why a book exists at all: Maia is *exactly* deterministic (argmax of a softmax
 * over legal moves is a pure function of the FEN and rating), and Stockfish is
 * close to it. Replaying the same start position N times is one game wearing N
 * costumes — the effective sample size is 1, and every interval computed off it
 * is a lie. Distinct positions are what decorrelate the games; the engines are
 * untouched.
 */
export interface OpeningLine {
  /** Stable key written into the games log, so a rerun can be matched up. */
  id: string;
  /** Human name, for reading the log. Not used as a key. */
  name: string;
  /** SAN plies applied before the engines take over. */
  san: string[];
}

/**
 * One completed game, as written to `fixtures/games-log.jsonl` (one object per
 * line — a new game is a pure append, not a rewrite of a growing array).
 *
 * `white`/`black` are preset *labels*. `EngineConfig` has no dedicated id and
 * adding one is a wider change than this task wants to force through
 * `lib/chess/types.ts`, so the label is the key — with the obvious consequence
 * that renaming a preset orphans its history. Noted in the spec's Risks.
 */
export interface MatchGameResult {
  openingId: string;
  white: string;
  black: string;
  result: "1-0" | "0-1" | "1/2-1/2";
  endReason: string;
  /** Full SAN, book prefix included — `runModelGame` only reports its own plies. */
  moves: string[];
  timestamp: number;
  /**
   * A game that didn't reach a real conclusion. `ratingBT.ts` skips these.
   *
   * `matchRunner.ts` never sets it — a game interrupted by an abort or an engine
   * failure is simply not logged, since a half-played game has no result to
   * record. The flag exists for the log's sake: if a game ever needs to be kept
   * but not counted, this is how you say so without deleting the line.
   */
  incomplete?: boolean;
  /**
   * Which match run produced this game. Lets `ratings.json` tie a stored SPRT
   * terminal state back to the games it was computed from, so the decision is
   * reproducible from the log rather than taken on trust.
   */
  runId?: string;
}

/** A game's outcome from one fixed side's point of view. */
export type GameOutcome = "win" | "draw" | "loss";

export interface SprtConfig {
  /** Preset label the hypotheses are stated *about*. */
  a: string;
  /** Its opponent. `elo0`/`elo1` are both `a` minus `b`. */
  b: string;
  /** H0: the true Elo gap is this. Usually 0 — "no real difference". */
  elo0: number;
  /** H1: the true Elo gap is this. */
  elo1: number;
  /** Type-I error: probability of accepting H1 when H0 is true. */
  alpha: number;
  /** Type-II error: probability of accepting H0 when H1 is true. */
  beta: number;
  /** Davidson tie parameter. Shared with the rating fit — one model, not two. */
  gamma: number;
  /** Hard cap alongside the LLR bounds, same as fishtest keeps. */
  maxGames: number;
}

export type SprtDecision = "continue" | "accept-h1" | "accept-h0" | "max-games";

export interface SprtState {
  config: SprtConfig;
  /** Counts from `a`'s point of view. */
  wins: number;
  draws: number;
  losses: number;
  games: number;
  /** Running Σ ln(P_H1(R)/P_H0(R)). */
  llr: number;
  /** ln((1-β)/α) — cross it upward and H1 is accepted. */
  boundA: number;
  /** ln(β/(1-α)) — cross it downward and H0 is accepted. */
  boundB: number;
  decision: SprtDecision;
}

export interface RatingEstimate {
  /** The preset's label, doubling as its id. */
  presetId: string;
  /** Fitted Elo on the anchored scale. */
  elo: number;
  /**
   * Standard error in Elo, from the inverse observed-information matrix.
   * Null for the anchor (fixed by definition, not estimated) and for any preset
   * the fit refused to rate.
   */
  stderr: number | null;
  games: number;
  /** Wins + half the draws. */
  score: number;
  anchor: boolean;
  /** False when Ford's condition fails for this preset — see `ratingBT.ts`. */
  rated: boolean;
  /** Why it isn't rated, when it isn't. */
  note?: string;
}

export interface BradleyTerryFit {
  ratings: RatingEstimate[];
  /** Fitted Davidson tie parameter. 0 recovers plain Bradley-Terry. */
  drawParam: number;
  /** Standard error on `drawParam`, or null if it was held fixed. */
  drawParamStderr: number | null;
  converged: boolean;
  iterations: number;
  /** Games actually used — completed games between two rateable presets. */
  gamesUsed: number;
  /** Anything the reader needs to know before trusting the numbers. */
  warnings: string[];
}
