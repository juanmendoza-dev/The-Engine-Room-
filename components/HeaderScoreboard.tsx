"use client";

import { useSyncExternalStore } from "react";

import {
  getBoardFrame,
  getServerBoardFrame,
  moveNumberOf,
  subscribeBoardFrame,
  whiteToMove,
} from "@/lib/boardFeed";

/**
 * The header's live scoreboard. Replaces the old "Live — engines coupled" badge,
 * which asserted a backend that doesn't exist; this reads the game that's
 * actually running — the hero's Opera Game replay, or a real game on either
 * play screen.
 *
 * Two squares for the two sides with the side to move ringed in red, the move
 * number, and the last move. No words but the label: the state is carried by
 * which square is lit, which reads before you've finished parsing it.
 *
 * Renders nothing when no board is mounted (e.g. /history). Dead chrome saying
 * "no game" would be worse than an empty slot.
 */
export function HeaderScoreboard() {
  const frame = useSyncExternalStore(subscribeBoardFrame, getBoardFrame, getServerBoardFrame);

  if (!frame) return null;

  const { ply, lastSan, over } = frame;
  const white = !over && whiteToMove(ply);
  const black = !over && !whiteToMove(ply);

  const spoken = over
    ? `Game over. Last move ${lastSan ?? "none"}.`
    : `Move ${moveNumberOf(ply)}, ${white ? "white" : "black"} to move.` +
      (lastSan ? ` Last move ${lastSan}.` : "");

  return (
    <div
      // role="img" + aria-label, deliberately NOT role="status": status carries
      // an implicit aria-live="polite", which would make a screen reader
      // announce this on every ply — once every 1.15s, forever, on the landing
      // page. As an image it's a single labelled graphic that's read when you
      // reach it and never shouts. The label also spares you the bare fragments
      // "Move", "4", "Bg4" being read as a sentence.
      role="img"
      aria-label={spoken}
      className="flex items-center gap-[14px] font-mono text-[11px] tracking-[0.22em] uppercase max-sm:hidden"
    >
      <span className="flex gap-1" aria-hidden>
        <i className="er-turn er-turn--w" data-on={white} />
        <i className="er-turn er-turn--b" data-on={black} />
      </span>

      <span className="text-er-dim text-[10px] tracking-[0.24em]">Move</span>

      {/* Tabular numerals plus a min-width wide enough for the worst case:
          without both, the whole cluster shifts sideways every time the digit
          count or the move length changes, which is exactly what makes a live
          readout feel cheap.

          `tracking-normal` undoes the header's inherited 0.22em — letterspacing
          on a single display numeral buys nothing and it defeats the min-width,
          since 3 tracked digits are wider than 3ch. 3ch covers move 100+, which
          a real Model 1v1 game reaches (the 50-move rule allows it). */}
      <span className="min-w-[3ch] text-center text-[15px] leading-none font-medium tracking-normal tabular-nums">
        {moveNumberOf(ply)}
      </span>

      {/* Notation is the one thing in this header that must NOT be uppercased:
          case is semantic. "Nxb5" -> "NXB5" loses the piece letter, and
          "dxe5" -> "DXE5" reads as a bishop move.

          8ch because the longest SAN this can print is a capture-promotion with
          check — "exd8=Q+", 7 characters. The hero replay never exceeds 5, but
          the play screens can, and that's the screen someone stares at. */}
      <span className="text-er-dim min-w-[8ch] tracking-[0.08em] normal-case">
        {lastSan ?? "—"}
      </span>
    </div>
  );
}
