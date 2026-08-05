// Wald's sequential probability ratio test, trinomial (win/draw/loss scored
// independently), over the Davidson model in `eloModel.ts`.
//
// The point of a sequential test rather than "play 100 games and look": the
// number of games needed depends on how big the real gap is, and you don't know
// that before you start. A wide gap declares itself in ~22 games; a 50-Elo one
// needs ~320. Fixing either number in advance either wastes hours or answers
// nothing.
//
// This is the textbook Wald (1945) derivation, not fishtest's GSPRT/pentanomial
// refinement — same method (sequential testing against an explicit elo0/elo1
// pair), simpler model. `2026-08-05-sprt-engine-ratings.md` explains why the
// pentanomial version is deliberately left as a future upgrade.

import { llrIncrement } from "./eloModel";
import type { GameOutcome, SprtConfig, SprtState } from "./types";

export const DEFAULT_ALPHA = 0.05;
export const DEFAULT_BETA = 0.05;

/**
 * A guess at sub-2800 draw rates, not a measurement — it is the same placeholder
 * the spec's worked example uses. Once real games exist, `ratingBT.ts` fits γ
 * from the pooled data and *that* is the number to feed back in here.
 */
export const PLACEHOLDER_GAMMA = 0.5;

export function createSprt(config: SprtConfig): SprtState {
  return {
    config,
    wins: 0,
    draws: 0,
    losses: 0,
    games: 0,
    llr: 0,
    boundA: Math.log((1 - config.beta) / config.alpha),
    boundB: Math.log(config.beta / (1 - config.alpha)),
    decision: "continue",
  };
}

/**
 * Fold one game into the running test. Pure — returns a new state, so a caller
 * can keep the whole sequence for a plot without defensive copying.
 *
 * A state that has already decided is returned untouched. That matters for
 * honesty as much as tidiness: continuing to accumulate past a boundary and then
 * reporting the final LLR would be a different test with different error rates
 * than the α/β the config claims.
 */
export function recordGame(state: SprtState, outcome: GameOutcome): SprtState {
  if (state.decision !== "continue") return state;

  const { elo0, elo1, gamma, maxGames } = state.config;
  const next: SprtState = {
    ...state,
    wins: state.wins + (outcome === "win" ? 1 : 0),
    draws: state.draws + (outcome === "draw" ? 1 : 0),
    losses: state.losses + (outcome === "loss" ? 1 : 0),
    games: state.games + 1,
    llr: state.llr + llrIncrement(outcome, elo0, elo1, gamma),
  };

  if (next.llr >= next.boundA) next.decision = "accept-h1";
  else if (next.llr <= next.boundB) next.decision = "accept-h0";
  else if (next.games >= maxGames) next.decision = "max-games";

  return next;
}

/**
 * Which side of a finished game the SPRT's reference preset was on.
 *
 * The runner plays each opening with colours swapped, so `a` is white in half
 * the games. Reading the raw `1-0` as "a won" is the sign error this exists to
 * make impossible.
 */
export function outcomeFor(
  referenceLabel: string,
  white: string,
  black: string,
  result: "1-0" | "0-1" | "1/2-1/2",
): GameOutcome {
  if (result === "1/2-1/2") return "draw";
  const referenceIsWhite = referenceLabel === white;
  if (!referenceIsWhite && referenceLabel !== black) {
    throw new Error(`${referenceLabel} did not play in this game (${white} vs ${black})`);
  }
  const whiteWon = result === "1-0";
  return whiteWon === referenceIsWhite ? "win" : "loss";
}

/** One line a human can read off a finished or in-flight run. */
export function describeSprt(state: SprtState): string {
  const { a, b, elo0, elo1 } = state.config;
  // Careful with the wording. Accepting H0 does not mean "no difference" — it
  // means the evidence favours a gap of elo0 over a gap of elo1, which for the
  // usual 0-vs-200 question is "not 200 Elo apart", not "identical". The point
  // estimate from ratingBT.ts is what says how far apart they actually look.
  const verdict =
    state.decision === "accept-h1"
      ? `H1 accepted: the gap looks closer to ${elo1} than to ${elo0} Elo, in ${a}'s favour`
      : state.decision === "accept-h0"
        ? `H0 accepted: the gap looks closer to ${elo0} than to ${elo1} Elo`
        : state.decision === "max-games"
          ? "inconclusive - hit the game cap before either bound"
          : "still running";
  return (
    `${a} vs ${b}: ${state.wins}W ${state.draws}D ${state.losses}L over ${state.games} games, ` +
    `LLR ${state.llr.toFixed(3)} in [${state.boundB.toFixed(3)}, ${state.boundA.toFixed(3)}] - ${verdict}`
  );
}
