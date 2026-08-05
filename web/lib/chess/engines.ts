import { getMaiaMove } from "./engineMaia";
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

export const ALL_ENGINE_PRESETS: EngineConfig[] = [...STOCKFISH_PRESETS, ...MAIA_PRESETS];

/**
 * The single entry point every screen and the game loop use. Nothing downstream
 * imports an engine module directly, which is what makes adding or dropping an
 * engine a change to this file only.
 *
 * `onInfo` receives Stockfish's `info ...` search lines as they stream. It's what
 * feeds the fight-FX "ki charge" bar a real search depth instead of a decorative
 * ramp. Maia never calls it — it's a policy network doing one forward pass, so
 * there is no search and no depth to report; callers should treat "no info" as
 * indeterminate rather than as zero.
 */
export async function getMoveFor(
  fen: string,
  config: EngineConfig,
  onInfo?: (line: string) => void,
): Promise<EngineMove> {
  if (config.type === "stockfish") return getStockfishMove(fen, config, onInfo);
  if (config.type === "maia") return getMaiaMove(fen, config);
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
