"use client";

import { Chessboard } from "react-chessboard";

interface BoardProps {
  fen: string;
  /** Model 1v1 leaves this false — the board is a spectator view there. */
  interactive?: boolean;
  onPieceDrop?: (from: string, to: string) => boolean;
  orientation?: "white" | "black";
}

/**
 * Thin wrapper over react-chessboard so the game screens don't depend on its
 * prop surface directly.
 *
 * react-chessboard v5 moved every prop into a single `options` object and
 * renamed `arePiecesDraggable` to `allowDragging` — the build plan's snippet was
 * written against v4 and doesn't compile here. Keeping that translation in one
 * file means the next major only breaks this component.
 */
export function Board({
  fen,
  interactive = false,
  onPieceDrop,
  orientation = "white",
}: BoardProps) {
  return (
    <Chessboard
      options={{
        id: "er-board",
        position: fen,
        boardOrientation: orientation,
        allowDragging: interactive,
        animationDurationInMs: 220,
        // Match the hero's board palette so this doesn't read as a different app.
        lightSquareStyle: { backgroundColor: "var(--er-sq-light)" },
        darkSquareStyle: { backgroundColor: "var(--er-sq-dark)" },
        onPieceDrop: ({ sourceSquare, targetSquare }) => {
          // targetSquare is null when a piece is dropped off-board.
          if (!onPieceDrop || !targetSquare) return false;
          return onPieceDrop(sourceSquare, targetSquare);
        },
      }}
    />
  );
}
