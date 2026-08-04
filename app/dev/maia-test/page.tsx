"use client";

// Scratch verification page for the Task 3 spike. Unstyled on purpose.
//
// The trap this page exists to avoid: Maia's decoder filters to legal moves and
// takes the best one, so a WRONG encoder still returns a perfectly legal move.
// "chess.js accepted it" therefore proves nothing here. Each check below is
// chosen for what it can actually falsify.

import { useEffect, useState } from "react";
import { Chess } from "chess.js";
import { evaluateMaia, mirrorMove } from "@/lib/chess/engineMaia";

const START = new Chess().fen();
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const WHITE_UP_A_QUEEN = "rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// Hand-written mirror pair. These are literal strings and are deliberately NOT
// produced by the engine's own mirrorFen(), because lc0-style encoders mirror
// black-to-move positions internally: generating the pair with the same helper
// the encoder uses makes encode(P') identical to encode(P) by construction, and
// the network then agrees with itself for free. Written out by hand, the check
// can actually fail.
const MIRROR_WHITE = "8/8/8/4k3/8/4K3/4P3/8 w - - 0 1";
const MIRROR_BLACK = "8/4p3/4k3/8/4K3/8/8/8 b - - 0 1";

const LEGALITY_FENS = [
  { label: "start position", fen: START },
  { label: "mid-opening", fen: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3" },
  { label: "king + pawn endgame", fen: "8/8/8/4k3/8/4K3/4P3/8 w - - 0 1" },
];

const HUMAN_OPENINGS = ["e2e4", "d2d4", "g1f3", "c2c4"];
const HUMAN_REPLIES = ["e7e5", "c7c5", "e7e6", "c7c6", "d7d5", "g8f6"];

function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

export default function MaiaTestPage() {
  const [lines, setLines] = useState<string[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const log = (line: string) => {
      if (!cancelled) setLines((prev) => [...prev, line]);
    };

    (async () => {
      try {
        // ── graph interface (CP4, done empirically rather than assumed) ──
        log("== graph: what the ONNX file actually exposes ==");
        const first = await evaluateMaia(START, {
          type: "maia",
          label: "Maia 1500",
          ratingTier: 1500,
        });
        log(`inputs:  ${first.inputNames.join(", ")}`);
        log(`outputs: ${first.outputNames.join(", ")}`);
        log("");

        // ── V1 replacement: does the rating input change anything? ──
        log("== rating responsiveness (primary check) ==");
        log("same FEN, different rating. identical output => elo input is ignored.");
        const ratings = [1100, 1500, 1900];
        const tops: Record<number, string> = {};
        for (const rating of ratings) {
          if (cancelled) return;
          const started = performance.now();
          const { policy } = await evaluateMaia(AFTER_E4, {
            type: "maia",
            label: `Maia ${rating}`,
            ratingTier: rating,
          });
          const ms = Math.round(performance.now() - started);
          tops[rating] = policy[0].uci;
          const top3 = policy
            .slice(0, 3)
            .map((p) => `${p.uci} ${pct(p.probability)}`)
            .join("  ");
          log(`elo ${rating}  ${top3}  (${ms}ms)`);
        }
        const distinct = new Set(Object.values(tops)).size;
        log(
          distinct > 1
            ? `PASS  top move differs across ratings (${distinct} distinct)`
            : "NOTE  same top move at every rating - compare the probabilities above; " +
                "identical probabilities would mean the elo input is not wired"
        );
        log("");

        // ── move table round-trip ──
        log("== move index table round-trip ==");
        const table: Record<string, number> = await (
          await fetch(
            "https://raw.githubusercontent.com/CSSLab/maia-platform-frontend/main/src/lib/engine/data/all_moves.json"
          )
        ).json();
        const reversed: string[] = [];
        for (const [uci, i] of Object.entries(table)) reversed[i] = uci;
        const entries = Object.entries(table);
        const broken = entries.filter(([uci, i]) => reversed[i] !== uci);
        log(
          `${broken.length === 0 ? "PASS" : "FAIL"}  ${entries.length} entries, ` +
            `${broken.length} round-trip mismatches`
        );
        log("");

        // ── mirror invariance ──
        log("== mirror invariance (weak: a failure is definitive, a pass proves little) ==");
        const w = await evaluateMaia(MIRROR_WHITE, { type: "maia", label: "m", ratingTier: 1500 });
        const b = await evaluateMaia(MIRROR_BLACK, { type: "maia", label: "m", ratingTier: 1500 });
        const expected = mirrorMove(w.policy[0].uci);
        log(`white-to-move : ${w.policy[0].uci}  value ${w.value.toFixed(4)}`);
        log(`black mirrored: ${b.policy[0].uci}  value ${b.value.toFixed(4)}`);
        log(
          `${b.policy[0].uci === expected ? "PASS" : "FAIL"}  expected mirrored move ${expected}; ` +
            `value delta ${Math.abs(w.value - b.value).toFixed(4)}`
        );
        log("");

        // ── value head sanity ──
        log("== value head sanity ==");
        const even = await evaluateMaia(START, { type: "maia", label: "m", ratingTier: 1500 });
        const ahead = await evaluateMaia(WHITE_UP_A_QUEEN, {
          type: "maia",
          label: "m",
          ratingTier: 1500,
        });
        log(`start position      value ${even.value.toFixed(4)}`);
        log(`white up a queen    value ${ahead.value.toFixed(4)}`);
        log(
          `${ahead.value > even.value ? "PASS" : "FAIL"}  ` +
            `expected a queen up to read better for the side to move`
        );
        log("");

        // ── policy plausibility ──
        log("== policy plausibility ==");
        const startTop = even.policy[0].uci;
        log(
          `${HUMAN_OPENINGS.includes(startTop) ? "PASS" : "FAIL"}  ` +
            `start position top move ${startTop} (want one of ${HUMAN_OPENINGS.join("/")})`
        );
        const replyTop = tops[1500];
        log(
          `${HUMAN_REPLIES.includes(replyTop) ? "PASS" : "FAIL"}  ` +
            `reply to 1.e4 top move ${replyTop} (want one of ${HUMAN_REPLIES.join("/")})`
        );
        log("");

        // ── legality (necessary, not sufficient) ──
        log("== legality (necessary, NOT sufficient) ==");
        for (const testCase of LEGALITY_FENS) {
          if (cancelled) return;
          const { policy } = await evaluateMaia(testCase.fen, {
            type: "maia",
            label: "m",
            ratingTier: 1500,
          });
          const uci = policy[0].uci;
          const chess = new Chess(testCase.fen);
          let san: string | null = null;
          try {
            san = chess.move({
              from: uci.slice(0, 2),
              to: uci.slice(2, 4),
              promotion: uci.length > 4 ? uci.slice(4, 5) : undefined,
            })?.san ?? null;
          } catch {
            san = null;
          }
          log(
            `${san ? "LEGAL  " : "ILLEGAL"}  ${testCase.label.padEnd(20)} ${uci}` +
              `${san ? ` (${san})` : ""}`
          );
        }
      } catch (err) {
        log(`ERROR  ${(err as Error).message}`);
      }

      if (!cancelled) setDone(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <pre style={{ padding: "2rem", fontSize: 13, lineHeight: 1.65 }}>
      {"maia spike (Maia 2 rapid, MIT)\n\n"}
      {lines.length === 0 ? "fetching ~89MB model, this takes a moment...\n" : lines.join("\n") + "\n"}
      {done ? "\ndone" : "\nrunning..."}
    </pre>
  );
}
