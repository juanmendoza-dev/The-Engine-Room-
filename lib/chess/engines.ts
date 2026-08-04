import { getStockfishMove } from "./engineStockfish";
import type { EngineConfig, EngineMove } from "./types";

export const STOCKFISH_PRESETS: EngineConfig[] = [
  { type: "stockfish", label: "Stockfish 1320", elo: 1320 },
  { type: "stockfish", label: "Stockfish 1800", elo: 1800 },
  { type: "stockfish", label: "Stockfish 2800", elo: 2800 },
];

// Empty until Task 3 lands. That's the documented fallback from
// docs/phase-0-engine-spike.md, and right now it's simply the truth: there is no
// lib/chess/engineMaia.ts on main — PR #7 is spec-only, and the task is a
// timeboxed investigation that may end without a working weight file.
//
// TO ADD MAIA, when engineMaia.ts exists, three lines and nothing else:
//   1. import { getMaiaMove } from "./engineMaia";
//   2. fill this array with the tiers that actually verified
//   3. add the `config.type === "maia"` branch to getMoveFor below
// Deliberately NOT importing it speculatively — a static import of a missing
// module fails the build, so the plan's Task 4 snippet cannot compile as written
// today.
export const MAIA_PRESETS: EngineConfig[] = [];

export const ALL_ENGINE_PRESETS: EngineConfig[] = [...STOCKFISH_PRESETS, ...MAIA_PRESETS];

/**
 * The single entry point every screen and the game loop use. Nothing downstream
 * imports an engine module directly, which is what makes adding or dropping an
 * engine a change to this file only.
 */
export async function getMoveFor(fen: string, config: EngineConfig): Promise<EngineMove> {
  if (config.type === "stockfish") return getStockfishMove(fen, config);
  throw new Error(`No engine available for config type: ${config.type}`);
}
