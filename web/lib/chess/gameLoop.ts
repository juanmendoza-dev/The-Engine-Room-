import { Chess, type Move } from "chess.js";

import { getMoveFor, parseSearchDepth } from "./engines";
import type { EngineConfig } from "./types";

export interface GameEndInfo {
  result: "1-0" | "0-1" | "1/2-1/2";
  endReason: "checkmate" | "stalemate" | "draw-repetition" | "draw-50move" | "draw-insufficient";
}

export interface ModelGameResult extends GameEndInfo {
  moves: string[];
}

/**
 * Everything about a ply that just landed. `move` is the verbose object chess.js
 * returns from `.move()`, which this loop used to keep only the `san` off — the
 * fight-FX layer needs the from/to vector, the piece, and what got captured, and
 * SAN can't supply the origin square (`Nf3` never says which knight).
 */
export interface MovePlayed {
  move: Move;
  fen: string;
  san: string;
  isCheck: boolean;
  isCheckmate: boolean;
  /** Full SAN history including this move — the FX opening lookup wants it. */
  history: string[];
  /** True when the move came from the defensive random-legal fallback. */
  fallback: boolean;
}

export interface RunModelGameOptions {
  /**
   * Pause *between* moves. Deliberately short: Stockfish already spends
   * MOVE_TIME_MS (500ms) thinking per move, so the board never actually snaps
   * instantly. 500 + 350 puts a ply just under a second — watchable without a
   * full game dragging past a couple of minutes.
   *
   * `onMove` can override this per ply by returning a number, which is how the
   * fight-FX hit-stop buys a capture or a checkmate the extra beats it needs.
   */
  moveDelayMs?: number;
  /** Abort a game in flight (component unmount, rematch, navigating away). */
  signal?: AbortSignal;
  /**
   * Start from this position instead of the standard opening.
   *
   * Added for the SPRT match runner (Task 16), which opens every game from a
   * randomized book: both engines are close to deterministic, so replaying the
   * start position N times is one game wearing N costumes and every interval
   * computed off it is a lie. Distinct *positions* are what decorrelate the
   * sample — nothing about either engine changes.
   *
   * Note the returned `moves` still only covers plies this loop played. A caller
   * that wants the whole game concatenates its own prefix.
   */
  startFen?: string;
  /** Fires before each search starts, so the UI can show who's thinking. */
  onThinkStart?: (side: "w" | "b", engine: EngineConfig) => void;
  /**
   * Stockfish search depth as it climbs, per `info` line. Never called for Maia,
   * which does one forward pass and has no search depth to report.
   */
  onSearchDepth?: (side: "w" | "b", depth: number) => void;
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

/**
 * Exported for the User 1v1 screen, which reaches game-over one half-move at a
 * time instead of through runModelGame — one source of truth for how a finished
 * position maps to a result/reason, not two copies.
 */
export function describeEnd(chess: Chess): GameEndInfo {
  if (chess.isCheckmate()) {
    // The side to move is the one that got mated.
    return { result: chess.turn() === "w" ? "0-1" : "1-0", endReason: "checkmate" };
  }
  if (chess.isStalemate()) return { result: "1/2-1/2", endReason: "stalemate" };
  if (chess.isThreefoldRepetition()) return { result: "1/2-1/2", endReason: "draw-repetition" };
  if (chess.isInsufficientMaterial()) return { result: "1/2-1/2", endReason: "draw-insufficient" };
  return { result: "1/2-1/2", endReason: "draw-50move" };
}

function randomLegalMove(chess: Chess): Move {
  const legal = chess.moves({ verbose: true });
  const pick = legal[Math.floor(Math.random() * legal.length)];
  return chess.move({ from: pick.from, to: pick.to, promotion: pick.promotion });
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
  /**
   * Called once per landed ply. Return a number to override the pause that
   * follows it — that's the fight-FX hit-stop hook. Return nothing for
   * `moveDelayMs`.
   */
  onMove: (fen: string, sanMove: string, played: MovePlayed) => void | number,
  { moveDelayMs = 350, signal, onThinkStart, onSearchDepth, startFen }: RunModelGameOptions = {},
): Promise<ModelGameResult> {
  const chess = new Chess(startFen);
  const moves: string[] = [];

  while (!chess.isGameOver()) {
    if (signal?.aborted) throw new GameAbortedError();

    const side = chess.turn();
    const active = side === "w" ? white : black;
    onThinkStart?.(side, active);

    const move = await getMoveFor(
      chess.fen(),
      active,
      onSearchDepth &&
        ((line) => {
          const depth = parseSearchDepth(line);
          if (depth !== null) onSearchDepth(side, depth);
        }),
    );

    // An engine reply we no longer want — the user hit rematch or left mid-search.
    if (signal?.aborted) throw new GameAbortedError();

    let applied: Move;
    let fallback = false;
    try {
      applied = chess.move({ from: move.from, to: move.to, promotion: move.promotion });
    } catch {
      // Defensive fallback per the spec: chess.js stays authoritative, so an
      // engine returning something outside chess.moves() costs us one random
      // legal move rather than breaking the game.
      //
      // Note this is a catch, not a null check: chess.js 1.x THROWS on an
      // invalid move (older versions returned null), so the build plan's
      // `if (!applied)` branch would never have run.
      console.warn(`Illegal move from ${active.label}:`, move, "— playing a random legal move");
      applied = randomLegalMove(chess);
      fallback = true;
    }

    moves.push(applied.san);
    const requested = onMove(chess.fen(), applied.san, {
      move: applied,
      fen: chess.fen(),
      san: applied.san,
      isCheck: chess.isCheck(),
      isCheckmate: chess.isCheckmate(),
      history: chess.history(),
      fallback,
    });

    await sleep(typeof requested === "number" ? requested : moveDelayMs, signal);
  }

  return { moves, ...describeEnd(chess) };
}
