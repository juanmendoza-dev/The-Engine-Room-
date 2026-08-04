"use client";

// Scratch verification page for the Task 2 spike. Task 8 deletes this once the
// real Model 1v1 screen supersedes it. Deliberately unstyled.

import { useEffect, useState } from "react";
import { Chess } from "chess.js";
import { getStockfishMove } from "@/lib/chess/engineStockfish";

const CASES = [
  { label: "start position", fen: new Chess().fen(), elo: 1320 },
  {
    label: "mid-opening",
    fen: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
    elo: 1800,
  },
  { label: "king + pawn endgame", fen: "8/8/8/4k3/8/4K3/4P3/8 w - - 0 1", elo: 2800 },
];

export default function StockfishTestPage() {
  const [lines, setLines] = useState<string[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const log = (line: string) => {
      if (!cancelled) setLines((prev) => [...prev, line]);
    };

    (async () => {
      for (const testCase of CASES) {
        if (cancelled) return;
        const started = performance.now();

        try {
          const move = await getStockfishMove(testCase.fen, {
            type: "stockfish",
            label: `Stockfish ${testCase.elo}`,
            elo: testCase.elo,
          });

          // chess.js is the authority: if it won't apply the move, the move is
          // not legal, whatever the engine thinks.
          const chess = new Chess(testCase.fen);
          let applied = null;
          try {
            applied = chess.move(move);
          } catch {
            applied = null;
          }

          const ms = Math.round(performance.now() - started);
          log(
            `${applied ? "LEGAL  " : "ILLEGAL"}  elo ${testCase.elo}  ${testCase.label}  ` +
              `${move.from}${move.to}${move.promotion ?? ""}` +
              `${applied ? ` (${applied.san})` : ""}  ${ms}ms`
          );
        } catch (err) {
          log(`ERROR    ${testCase.label}  ${(err as Error).message}`);
        }
      }
      if (!cancelled) setDone(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <pre style={{ padding: "2rem", fontSize: 14, lineHeight: 1.7 }}>
      {`stockfish spike - ${CASES.length} positions\n\n`}
      {lines.length === 0 ? "loading engine...\n" : lines.join("\n") + "\n"}
      {done ? "\ndone" : "\nrunning..."}
    </pre>
  );
}
