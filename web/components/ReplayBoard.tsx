"use client";

import { useEffect, useState, type CSSProperties } from "react";

import { publishBoardFrame } from "@/lib/boardFeed";

/**
 * The hero's board: replays Morphy's Opera Game (1858) on a loop, one ply per
 * tick. Deliberately dependency-free — the moves are a hardcoded script, so the
 * landing page needs neither chess.js nor an engine to feel alive.
 *
 * Replaces the old static MiniBoard. Captured pieces are flagged rather than
 * removed so React keys stay stable and CSS transitions handle the exit.
 */

const GLYPH: Record<string, string> = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };

/**
 * [from, to, SAN, optional second move for castling] per ply. Ends on 17. Rd8#.
 *
 * The SAN is here rather than derived because this board deliberately has no
 * chess.js — it's a fixed script, so the notation is just more script. The
 * header's scoreboard reads it off the feed.
 */
const GAME: [string, string, string, [string, string]?][] = [
  ["e2", "e4", "e4"], ["e7", "e5", "e5"], ["g1", "f3", "Nf3"], ["d7", "d6", "d6"],
  ["d2", "d4", "d4"], ["c8", "g4", "Bg4"], ["d4", "e5", "dxe5"], ["g4", "f3", "Bxf3"],
  ["d1", "f3", "Qxf3"], ["d6", "e5", "dxe5"], ["f1", "c4", "Bc4"], ["g8", "f6", "Nf6"],
  ["f3", "b3", "Qb3"], ["d8", "e7", "Qe7"], ["b1", "c3", "Nc3"], ["c7", "c6", "c6"],
  ["c1", "g5", "Bg5"], ["b7", "b5", "b5"], ["c3", "b5", "Nxb5"], ["c6", "b5", "cxb5"],
  ["c4", "b5", "Bxb5+"], ["b8", "d7", "Nbd7"],
  ["e1", "c1", "O-O-O", ["a1", "d1"]], ["a8", "d8", "Rd8"], ["d1", "d7", "Rxd7"],
  ["d8", "d7", "Rxd7"], ["h1", "d1", "Rd1"], ["e7", "e6", "Qe6"], ["b5", "d7", "Bxd7+"],
  ["f6", "d7", "Nxd7"], ["b3", "b8", "Qb8+"], ["d7", "b8", "Nxb8"], ["d1", "d8", "Rd8#"],
];

const TICK_MS = 1150;

interface Piece {
  id: number;
  sq: string;
  glyph: string;
  color: "w" | "b";
  captured: boolean;
}

interface ReplayState {
  pieces: Piece[];
  ply: number;
  last: [string, string] | null;
}

function startPosition(): Piece[] {
  const back = ["r", "n", "b", "q", "k", "b", "n", "r"];
  const pieces: Piece[] = [];
  let id = 0;
  for (let f = 0; f < 8; f++) {
    const file = "abcdefgh"[f];
    const rows: [string, "w" | "b", string][] = [
      [back[f], "b", `${file}8`],
      ["p", "b", `${file}7`],
      ["p", "w", `${file}2`],
      [back[f], "w", `${file}1`],
    ];
    for (const [type, color, sq] of rows) {
      pieces.push({ id: id++, sq, glyph: GLYPH[type], color, captured: false });
    }
  }
  return pieces;
}

const fileOf = (sq: string) => sq.charCodeAt(0) - 97;
const rankOf = (sq: string) => 8 - Number(sq[1]); // row 0 = rank 8, white at bottom

function squareTransform(sq: string): string {
  return `translate(calc(${fileOf(sq)} * var(--sq)), calc(${rankOf(sq)} * var(--sq)))`;
}

function advance(state: ReplayState): ReplayState {
  if (state.ply >= GAME.length) return { pieces: startPosition(), ply: 0, last: null };

  const [from, to, , castleRook] = GAME[state.ply];
  let pieces = state.pieces;
  const apply = (f: string, t: string) => {
    pieces = pieces.map((p) => {
      if (p.captured) return p;
      if (p.sq === t) return { ...p, captured: true };
      if (p.sq === f) return { ...p, sq: t };
      return p;
    });
  };
  apply(from, to);
  if (castleRook) apply(castleRook[0], castleRook[1]);

  return { pieces, ply: state.ply + 1, last: [from, to] };
}

export function ReplayBoard() {
  const [state, setState] = useState<ReplayState>(() => ({
    pieces: startPosition(),
    ply: 0,
    last: null,
  }));

  useEffect(() => {
    const timer = setInterval(() => setState(advance), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // Feed the header's scoreboard. Publishing from an effect (rather than from
  // the tick) keeps this in step with whatever is actually rendered, including
  // the reset back to ply 0 when the replay loops. Not a setState — it's an
  // external store, see lib/boardFeed.ts for why that distinction matters here.
  useEffect(() => {
    publishBoardFrame({
      ply: state.ply,
      lastSan: state.ply > 0 ? GAME[state.ply - 1][2] : null,
      over: state.ply >= GAME.length,
    });
  }, [state.ply]);

  // The header outlives this board, so it has to be told when the board goes.
  useEffect(() => {
    return () => publishBoardFrame(null);
  }, []);

  const counter =
    state.ply === 0
      ? "Move 0"
      : state.ply >= GAME.length
        ? "17. Rd8# 1-0"
        : `Move ${Math.ceil(state.ply / 2)}`;

  return (
    <div style={{ "--sq": "min(11vw, 56px)" } as CSSProperties}>
      <div className="er-board-frame">
        <div
          className="relative h-[calc(var(--sq)*8)] w-[calc(var(--sq)*8)]"
          aria-label="Chessboard replaying the Opera Game"
        >
          {Array.from({ length: 64 }, (_, i) => {
            const r = Math.floor(i / 8);
            const f = i % 8;
            return (
              <div
                key={i}
                className="er-cell"
                style={{
                  left: `calc(${f} * var(--sq))`,
                  top: `calc(${r} * var(--sq))`,
                  background: (r + f) % 2 ? "var(--er-sq-dark)" : "var(--er-sq-light)",
                  animationDelay: `${0.35 + (r + f) * 0.045}s`,
                }}
              />
            );
          })}

          {state.last?.map((sq, i) => (
            <div
              key={i}
              className="er-hl"
              style={{ opacity: 1, transform: squareTransform(sq) }}
            />
          ))}

          {state.pieces.map((p) => (
            <span
              key={p.id}
              className={`er-piece er-piece--${p.color} ${p.captured ? "er-piece--captured" : ""}`}
              style={{ transform: squareTransform(p.sq) }}
            >
              {p.glyph}
            </span>
          ))}
        </div>
      </div>
      <div className="text-er-dim mt-[10px] flex justify-between gap-5 font-mono text-[10px] tracking-[0.2em] uppercase">
        <span>Morphy · Opera Game · 1858</span>
        <span>{counter}</span>
      </div>
    </div>
  );
}
