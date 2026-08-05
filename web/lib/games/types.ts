// Shared shapes for the game log.
//
// These deliberately live here and NOT in app/actions/games.ts: that file is
// "use server", so everything it exports must be an async function — it can't
// export types to client components. Both storage adapters and every screen
// import the shapes from this file.

import type { EngineType } from "@/lib/chess/types";

export type GameMode = "model-1v1" | "user-1v1";
export type GameResult = "1-0" | "0-1" | "1/2-1/2";

export interface GamePlayer {
  type: EngineType; // "stockfish" | "maia" | "human" | "mixture"
  label: string; // e.g. "Stockfish 1800", "You"
}

/** One finished game, as stored. Matches the KV schema in the design doc. */
export interface GameRecord {
  id: string;
  mode: GameMode;
  white: GamePlayer;
  black: GamePlayer;
  /** SAN move list, in play order. */
  moves: string[];
  result: GameResult;
  endReason: string; // "checkmate" | "stalemate" | "draw-*"
  timestamp: number; // ms since epoch, set at save time
}

/** What callers hand to saveGame — id and timestamp are filled in on save. */
export type NewGameRecord = Omit<GameRecord, "id" | "timestamp">;
