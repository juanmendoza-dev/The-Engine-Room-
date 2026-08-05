/**
 * The header's live readout reads from here.
 *
 * Any board, on any route, publishes what it's doing; the header's scoreboard
 * subscribes. That's how "Live" in the header stops being decoration and starts
 * describing an actual game — the hero's replay, a Model 1v1 run, or a game
 * you're playing yourself.
 *
 * Deliberately a module-level store rather than React context. The header lives
 * in the root layout and every board lives inside the page, so a context
 * provider would have to wrap the whole layout, and publishing upward from a
 * child to that provider means calling setState from an effect — which trips
 * `react-hooks/set-state-in-effect` (the same trap `TransitionLink`'s pressed
 * state hit, see docs/design/ink-and-bone-notes.md). An external store is the
 * shape React ships for exactly this, via `useSyncExternalStore`.
 */

export interface BoardFrame {
  /** Half-moves played so far. 0 = the game hasn't started. */
  ply: number;
  /** The last move in SAN ("Nxb5"), or null before the first move. */
  lastSan: string | null;
  /** True once the game is finished — no further move is coming. */
  over: boolean;
}

/** `null` means no board on this route, which is not the same as a board at ply 0. */
let frame: BoardFrame | null = null;

const listeners = new Set<() => void>();

/** Boards call this on every ply, and with `null` when they unmount. */
export function publishBoardFrame(next: BoardFrame | null): void {
  frame = next;
  for (const listener of listeners) listener();
}

export function subscribeBoardFrame(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Must return a stable reference while nothing has changed, or
    `useSyncExternalStore` re-renders forever. Only `publishBoardFrame` reassigns. */
export function getBoardFrame(): BoardFrame | null {
  return frame;
}

/** No board exists during SSR, so the header renders nothing until a board
    mounts and publishes. Keeps the server and first client render identical. */
export function getServerBoardFrame(): BoardFrame | null {
  return null;
}

/** Move number as a player counts them: ply 1 and 2 are both move 1. */
export function moveNumberOf(ply: number): number {
  return Math.ceil(ply / 2);
}

/** White moves on even plies — 0 plies played means white is to move. */
export function whiteToMove(ply: number): boolean {
  return ply % 2 === 0;
}
