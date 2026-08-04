"use client";

// Scratch verification page for the Task 2 spike. Task 8 deletes this once the
// real Model 1v1 screen supersedes it. Deliberately unstyled.
//
// Three things are being checked, and they need different evidence:
//
//  1. Are the options we set real? A UCI engine silently ignores `setoption` for
//     a name it doesn't know, so a typo is indistinguishable from a working
//     option at runtime. The `uci` handshake's advertised list is the only tell.
//  2. Does the engine return a legal move? chess.js answers that.
//  3. Is it actually searching? Wall-clock time does NOT answer that - a wrapper
//     that slept for `movetime` and returned a random legal move would produce
//     identical timings. The `info depth ...` lines are the direct evidence, so
//     we report the depth reached.
//
// What this page deliberately does NOT establish: that UCI_Elo changes playing
// strength. Depth comes out the same at 1320 and 2800 because Stockfish limits
// strength by picking a weaker move from the multi-PV candidates, not by
// searching shallower. Measuring that needs whole games - Task 6's territory.

import { useEffect, useState } from "react";
import { Chess } from "chess.js";
import { getAdvertisedOptions, getStockfishMove } from "@/lib/chess/engineStockfish";

const LEGALITY_CASES = [
  { label: "start position", fen: new Chess().fen(), elo: 1320 },
  {
    label: "mid-opening",
    fen: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
    elo: 1800,
  },
  { label: "king + pawn endgame", fen: "8/8/8/4k3/8/4K3/4P3/8 w - - 0 1", elo: 2800 },
];

// One position, two ELOs, twice each so a single outlier can't carry the result.
const COMPARISON_FEN = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";
const COMPARISON_ELOS = [1320, 2800];
const RUNS_PER_ELO = 2;

interface Attempt {
  legal: boolean;
  uci: string;
  san: string | null;
  depth: number | null;
  ms: number;
}

/** Highest `depth` seen in the search's info stream. */
function parseDepth(infoLine: string): number | null {
  const match = infoLine.match(/\bdepth (\d+)/);
  return match ? Number(match[1]) : null;
}

async function runOne(fen: string, elo: number): Promise<Attempt> {
  let depth: number | null = null;
  const started = performance.now();

  const move = await getStockfishMove(
    fen,
    { type: "stockfish", label: `Stockfish ${elo}`, elo },
    (line) => {
      const d = parseDepth(line);
      if (d !== null && (depth === null || d > depth)) depth = d;
    }
  );

  const ms = Math.round(performance.now() - started);

  // chess.js is the authority: if it won't apply the move, the move is not
  // legal, whatever the engine thinks. v1 throws rather than returning null.
  const chess = new Chess(fen);
  let san: string | null = null;
  try {
    san = chess.move(move)?.san ?? null;
  } catch {
    san = null;
  }

  return {
    legal: san !== null,
    uci: `${move.from}${move.to}${move.promotion ?? ""}`,
    san,
    depth,
    ms,
  };
}

export default function StockfishTestPage() {
  const [lines, setLines] = useState<string[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const log = (line: string) => {
      if (!cancelled) setLines((prev) => [...prev, line]);
    };

    (async () => {
      // A UCI engine silently ignores `setoption` for a name it doesn't know, so
      // a typo'd option is indistinguishable from a working one at runtime. The
      // handshake is where you find out whether the knob is real.
      log("== options: does this build actually advertise the knobs we set? ==");
      try {
        const options = await getAdvertisedOptions();
        for (const name of ["UCI_LimitStrength", "UCI_Elo"]) {
          const found = options.find((o) => o.startsWith(`option name ${name} `));
          log(found ?? `MISSING  ${name} is not advertised by this build`);
        }
      } catch (err) {
        log(`ERROR    reading options  ${(err as Error).message}`);
      }

      if (cancelled) return;
      log("");
      log("== legality: does every position yield a chess.js-legal move? ==");
      for (const testCase of LEGALITY_CASES) {
        if (cancelled) return;
        try {
          const r = await runOne(testCase.fen, testCase.elo);
          log(
            `${r.legal ? "LEGAL  " : "ILLEGAL"}  elo ${testCase.elo}  ` +
              `${testCase.label.padEnd(20)}  ${r.uci}${r.san ? ` (${r.san})` : ""}` +
              `  depth ${r.depth ?? "NONE"}  ${r.ms}ms`
          );
        } catch (err) {
          log(`ERROR    ${testCase.label}  ${(err as Error).message}`);
        }
      }

      if (cancelled) return;
      log("");
      // Note: depth does NOT differ by ELO on this build. Stockfish's strength
      // limiting picks a weaker move from the multi-PV candidates rather than
      // truncating the search, so depth is not evidence either way about ELO.
      // Kept because the move choices are informative and the depth values are
      // the evidence that a real search happened at all.
      log("== strength: same position, two ELOs, depth + move played ==");
      for (const elo of COMPARISON_ELOS) {
        for (let run = 1; run <= RUNS_PER_ELO; run++) {
          if (cancelled) return;
          try {
            const r = await runOne(COMPARISON_FEN, elo);
            log(
              `elo ${String(elo).padEnd(4)}  run ${run}  depth ${String(r.depth ?? "NONE").padEnd(4)}` +
                `  played ${r.san ?? r.uci}  ${r.ms}ms`
            );
          } catch (err) {
            log(`ERROR    elo ${elo} run ${run}  ${(err as Error).message}`);
          }
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
      {"stockfish spike\n\n"}
      {lines.length === 0 ? "loading engine...\n" : lines.join("\n") + "\n"}
      {done ? "\ndone" : "\nrunning..."}
    </pre>
  );
}
