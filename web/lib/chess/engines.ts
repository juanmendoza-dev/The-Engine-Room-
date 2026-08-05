import { getMaiaMove } from "./engineMaia";
import { getMixtureMove } from "./engineMixture";
import { getStockfishMove } from "./engineStockfish";
import type { EngineConfig, EngineMove } from "./types";

export const STOCKFISH_PRESETS: EngineConfig[] = [
  { type: "stockfish", label: "Stockfish 1320", elo: 1320 },
  { type: "stockfish", label: "Stockfish 1800", elo: 1800 },
  { type: "stockfish", label: "Stockfish 2800", elo: 2800 },
];

// Task 3 landed, so this is now populated. Maia 2 takes the rating as a model
// input rather than shipping one network per tier, so these three are the same
// weight file with a different `ratingTier` - and all three were the ratings
// actually verified in the spike (docs/maia-notes.md).
//
// Two things worth knowing before using these in a game loop:
//  - the first Maia move downloads ~89MB, so it is slow on a cold cache
//  - Maia answers in ~35ms once loaded, against Stockfish's ~500ms
export const MAIA_PRESETS: EngineConfig[] = [
  { type: "maia", label: "Maia 1100", ratingTier: 1100 },
  { type: "maia", label: "Maia 1500", ratingTier: 1500 },
  { type: "maia", label: "Maia 1900", ratingTier: 1900 },
];

// Deliberately not labelled with a strength number. Every other preset here shows
// a figure the engine itself was configured with — Stockfish's own `UCI_Elo`,
// Maia's own rating input — and this one has no such figure to show. `α:β = 1:1`
// means "no opinion yet", not "balanced": a win probability lives in 0..1 and a
// log-probability is unbounded below, so equal weights aren't a neutral midpoint,
// they're an arbitrary point on a scale nobody has calibrated. Putting a number on
// the label would be inventing one.
//
// What would earn a number: docs/specs/2026-08-05-sprt-engine-ratings.md's match
// harness reporting one. Until then `multiPv: 8` and `1:1` are starting guesses,
// and `/dev/mixture-test` is where the hand-calibration in the spec's step 1 runs.
//
// Two things that harness already measured, both relevant to whoever tunes these:
//
//  - **`multiPv: 8` costs ~5-6 plies of search depth** at the fixed 500ms budget
//    (depth 17 → 12, 20 → 14 against MultiPV=1). Kept at 8 anyway, because the
//    spec chose it and swapping in 4 would be trading one uncalibrated guess for
//    another — but it's a real cost, not a free widening, and SPRT should sweep it.
//  - **β = 1 is two to three orders of magnitude past where the blend balances.**
//    Measured: on the start position the choice flips from Stockfish's move to
//    Maia's between β = 0.001 and β = 0.01, and never flips back through β = 5.
//
//    That isn't a quirk of one position, it falls out of the units. With α fixed at
//    1, Stockfish can only overturn Maia's preference between two moves when
//    `Δ winProb > β · Δ log P`. The logistic is flat near cp 0 — its slope is
//    `k/4 ≈ 0.00092` per centipawn — so two candidates 10cp apart differ by ~0.009
//    in win probability, while their Maia log-probabilities routinely differ by ~2.
//    Solving with the real numbers from that position (Δ winProb 0.005 against
//    Δ log P 2.05) puts the crossover at β ≈ 0.0024, which is exactly where the
//    sweep found it.
//
//    So a calibrated β is likely O(0.001-0.01), and "1:1" is not a neutral
//    midpoint — it is deep in Maia-decides territory, where the Stockfish term only
//    reorders candidates whose policy probabilities are within a factor of
//    `e^(α/β) ≈ 2.7` of each other. Kept at 1 regardless, because the spec chose it
//    and a hand-picked 0.0024 would just be a better-informed guess without SPRT
//    behind it — but nobody should read this preset as a balanced blend.
//
// And one more, the most visible of the three:
//
//  - **At `temperature: 0` this preset draws against itself in 8 plies**, by
//    threefold repetition. Verified end to end on /model-1v1 by
//    `web/scripts/cdp-mixture-game.mjs`. With T=0 both sides are deterministic
//    functions of the position, so they walk a knight out and back and the start
//    position recurs on plies 4 and 8. Not a flaw in the blend — it's the
//    determinism problem `2026-08-05-sprt-engine-ratings.md` opens with, arriving in
//    eight moves rather than a hundred games.
//
//    T=0 is kept because the spec specifies it and because determinism is what makes
//    the engine reproducible for verification. But it makes mixture-vs-mixture a
//    poor watch, and any T > 0 fixes it. One field, real strength implications —
//    flagged rather than changed unilaterally.

export const MIXTURE_PRESETS: EngineConfig[] = [
  {
    type: "mixture",
    label: "Policy Mixture (uncalibrated)",
    ratingTier: 1500,
    multiPv: 8,
    alpha: 1,
    beta: 1,
    temperature: 0,
  },
];

export const ALL_ENGINE_PRESETS: EngineConfig[] = [
  ...STOCKFISH_PRESETS,
  ...MAIA_PRESETS,
  ...MIXTURE_PRESETS,
];

/**
 * Does this config download the ~93MB Maia weight file?
 *
 * Exists because two lookalike checks in the page components need **opposite**
 * treatment for a mixture config, and a naive "add mixture everywhere" pass gets
 * one right and the other backwards:
 *
 *  - `<MaiaLoadNotice>` — yes, include mixture. It pays exactly the same download,
 *    so a screen that doesn't warn about it just looks frozen for 25 seconds.
 *  - the ki-charge bar's indeterminate state — no, exclude mixture. Maia alone has
 *    no search and therefore no depth to report, but the mixture's internal
 *    Stockfish call streams real `info depth` lines through the same `onInfo`
 *    passthrough, so it should show a real bar like any Stockfish config.
 *
 * A named predicate for the first case makes the second one's plain
 * `type === "maia"` read as deliberate rather than as a spot somebody missed.
 */
export function usesMaiaWeights(config: EngineConfig): boolean {
  return config.type === "maia" || config.type === "mixture";
}

/**
 * The single entry point every screen and the game loop use. Nothing downstream
 * imports an engine module directly, which is what makes adding or dropping an
 * engine a change to this file only.
 *
 * `onInfo` receives Stockfish's `info ...` search lines as they stream. It's what
 * feeds the fight-FX "ki charge" bar a real search depth instead of a decorative
 * ramp. Maia never calls it — it's a policy network doing one forward pass, so
 * there is no search and no depth to report; callers should treat "no info" as
 * indeterminate rather than as zero. A mixture config *does* call it, from its
 * internal Stockfish search, so it needs no such special case.
 */
export async function getMoveFor(
  fen: string,
  config: EngineConfig,
  onInfo?: (line: string) => void,
): Promise<EngineMove> {
  if (config.type === "stockfish") return getStockfishMove(fen, config, onInfo);
  if (config.type === "maia") return getMaiaMove(fen, config);
  if (config.type === "mixture") return getMixtureMove(fen, config, onInfo);
  throw new Error(`No engine available for config type: ${config.type}`);
}

/** `info depth 13 seldepth 18 ...` → 13. Null for lines without a depth field. */
export function parseSearchDepth(infoLine: string): number | null {
  const m = /\bdepth (\d+)/.exec(infoLine);
  return m ? Number(m[1]) : null;
}

export interface SearchScore {
  /** Centipawns, from the side to move's point of view. Null on a mate score. */
  cp: number | null;
  /** Moves to mate, signed: positive means the side to move is mating. */
  mate: number | null;
}

/**
 * `info ... score cp -24 ...` → `{ cp: -24, mate: null }`, `score mate 3` →
 * `{ cp: null, mate: 3 }`. Null for `info` lines carrying no score at all.
 *
 * Both are **relative to the side to move**, per UCI — not to white. Reading a cp
 * score as white's advantage is a sign error that only shows up on black's moves.
 *
 * Added for the rollout sanity check: "does a human-realistic win probability
 * move in the same direction as Stockfish's evaluation" needs a number to compare
 * against, and `parseSearchDepth` only ever pulled the depth out of this stream.
 */
export function parseSearchScore(infoLine: string): SearchScore | null {
  const cp = /\bscore cp (-?\d+)/.exec(infoLine);
  if (cp) return { cp: Number(cp[1]), mate: null };

  const mate = /\bscore mate (-?\d+)/.exec(infoLine);
  if (mate) return { cp: null, mate: Number(mate[1]) };

  return null;
}
