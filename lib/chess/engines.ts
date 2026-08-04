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
// actually verified in the spike (scripts/maia-notes.md).
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
 */
export async function getMoveFor(fen: string, config: EngineConfig): Promise<EngineMove> {
  if (config.type === "stockfish") return getStockfishMove(fen, config);
  if (config.type === "maia") return getMaiaMove(fen, config);
  throw new Error(`No engine available for config type: ${config.type}`);
}
