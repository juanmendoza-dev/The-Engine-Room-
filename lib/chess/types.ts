export type EngineType = "stockfish" | "maia" | "human";

export interface EngineConfig {
  type: EngineType;
  label: string;
  elo?: number; // stockfish only (UCI_Elo)
  ratingTier?: number; // maia only (1100-1900)
}

export interface EngineMove {
  from: string;
  to: string;
  promotion?: string;
}
