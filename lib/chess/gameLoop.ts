import { Chess } from "chess.js";

import { getMoveFor } from "./engines";
import type { EngineConfig } from "./types";

export interface GameEndInfo {
  result: "1-0" | "0-1" | "1/2-1/2";
  endReason: "checkmate" | "stalemate" | "draw-repetition" | "draw-50move" | "draw-insufficient";
}

export interface ModelGameResult extends GameEndInfo {
  moves: string[];
}

export interface RunModelGameOptions {
  /**
   * Pause *between* moves. Deliberately short: Stockfish already spends
   * MOVE_TIME_MS (500ms) thinking per move, so the board never actually snaps
   * instantly. 500 + 350 puts a ply just under a second — watchable without a
   * full game dragging past a couple of minutes.
   */
  moveDelayMs?: number;
  /** Abort a game in flight (component unmount, rematch, navigating away). */
  signal?: AbortSignal;
}

/** Thrown when `signal` aborts. Callers should swallow this, not surface it. */
export class GameAbortedError extends Error {
  constructor() {
    super("Game aborted");
    this.name = "GameAbortedError";
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new GameAbortedError());

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(new GameAbortedError());
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function describeEnd(chess: Chess): GameEndInfo {
  if (chess.isCheckmate()) {
    // The side to move is the one that got mated.
    return { result: chess.turn() === "w" ? "0-1" : "1-0", endReason: "checkmate" };
  }
  if (chess.isStalemate()) return { result: "1/2-1/2", endReason: "stalemate" };
  if (chess.isThreefoldRepetition()) return { result: "1/2-1/2", endReason: "draw-repetition" };
  if (chess.isInsufficientMaterial()) return { result: "1/2-1/2", endReason: "draw-insufficient" };
  return { result: "1/2-1/2", endReason: "draw-50move" };
}

function randomLegalMove(chess: Chess): string {
  const legal = chess.moves({ verbose: true });
  const pick = legal[Math.floor(Math.random() * legal.length)];
  chess.move({ from: pick.from, to: pick.to, promotion: pick.promotion });
  return pick.san;
}

/**
 * Plays one engine against another to completion, reporting each move as it
 * lands so the caller can render it.
 *
 * chess.js is the sole authority here: it validates every move and decides when
 * the game is over. No end-game logic of our own.
 */
export async function runModelGame(
  white: EngineConfig,
  black: EngineConfig,
  onMove: (fen: string, sanMove: string) => void,
  { moveDelayMs = 350, signal }: RunModelGameOptions = {},
): Promise<ModelGameResult> {
  const chess = new Chess();
  const moves: string[] = [];

  while (!chess.isGameOver()) {
    if (signal?.aborted) throw new GameAbortedError();

    const active = chess.turn() === "w" ? white : black;
    const move = await getMoveFor(chess.fen(), active);

    // An engine reply we no longer want — the user hit rematch or left mid-search.
    if (signal?.aborted) throw new GameAbortedError();

    let san: string;
    try {
      san = chess.move({ from: move.from, to: move.to, promotion: move.promotion }).san;
    } catch {
      // Defensive fallback per the spec: chess.js stays authoritative, so an
      // engine returning something outside chess.moves() costs us one random
      // legal move rather than breaking the game.
      //
      // Note this is a catch, not a null check: chess.js 1.x THROWS on an
      // invalid move (older versions returned null), so the build plan's
      // `if (!applied)` branch would never have run.
      console.warn(`Illegal move from ${active.label}:`, move, "— playing a random legal move");
      san = randomLegalMove(chess);
    }

    moves.push(san);
    onMove(chess.fen(), san);

    await sleep(moveDelayMs, signal);
  }

  return { moves, ...describeEnd(chess) };
}
