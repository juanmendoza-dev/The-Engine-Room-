"use client";

// Verification harness for the Monte Carlo rollouts (Task 14). Unstyled on
// purpose — it's an instrument.
//
// Run it against a PRODUCTION build (`npm run build && npm run start`). Under
// `next dev` StrictMode mounts the effect twice and every forward pass on this
// page happens twice, which on a page whose slowest check is a minute of wasm is
// not a small waste.
//
// Every check here is chosen for what it can falsify, following the same logic as
// /dev/maia-test: a rollout estimator that is silently wrong still returns three
// percentages that sum to 100 and look entirely reasonable. In particular a
// perspective bug — reading chess.js's 1-0 as the root mover's win when the root
// mover is black — produces plausible numbers pointing the wrong way, so two
// checks below exist only to catch it.
//
// Driven headless with:
//   node scripts/cdp-verify.mjs http://localhost:3000/dev/maia-rollout-test done 900000

import { useEffect, useState } from "react";
import { Chess } from "chess.js";

import {
  evaluateMaia,
  evaluateMaiaBatch,
  sampleFromPolicy,
  type MaiaEvaluation,
} from "@/lib/chess/engineMaia";
import { getMoveFor, parseSearchScore } from "@/lib/chess/engines";
import {
  runMaiaRollouts,
  valueToExpectedScore,
  wilsonInterval,
  type MaiaRolloutResult,
} from "@/lib/chess/maiaRollout";
import type { EngineConfig } from "@/lib/chess/types";

const TIER = 1500;
const MAIA_1500: EngineConfig = { type: "maia", label: "Maia 1500", ratingTier: TIER };

const START = new Chess().fen();
const MID_OPENING = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";
/** Black to move, so the batch rows exercise the mirroring path unevenly. */
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

/** White mates with Ra8#: black's king has no escape and its own pawns block it. */
const MATE_IN_1 = "6k1/5ppp/8/8/8/8/8/R6K w - - 0 1";
const MATING_MOVE = "a1a8";

/**
 * The same board twice, differing only in whose turn it is. White is a rook up,
 * so the first should win far more often than the second — and a perspective bug
 * makes them agree instead of invert.
 *
 * Black's king sits on h8 with luft on g7 deliberately. The obvious version of
 * this position (king g8, pawns f7/g7/h7) is a *mate in one* — Ra8# — so every
 * rollout ended on ply 1 and the pair stopped testing anything about long games.
 */
const ROOK_UP_WHITE_TO_MOVE = "7k/5p1p/6p1/8/8/8/5PPP/R5K1 w - - 0 1";
const ROOK_UP_BLACK_TO_MOVE = "7k/5p1p/6p1/8/8/8/5PPP/R5K1 b - - 0 1";

/** Short, sharp, and unambiguously ordered — for the Stockfish comparison. */
const LEVEL_ROOKS = "5rk1/5ppp/8/8/8/8/5PPP/5RK1 w - - 0 1";
const MOVER_UP_A_ROOK = "6k1/5ppp/8/8/8/8/5PPP/5RK1 w - - 0 1";
const MOVER_DOWN_A_ROOK = "5rk1/5ppp/8/8/8/8/5PPP/6K1 w - - 0 1";

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const verdict = (ok: boolean) => (ok ? "PASS" : "FAIL");

/** Seeded, so a sampler check that fails fails again on the next run. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function summarize(result: MaiaRolloutResult): string {
  return (
    `win ${pct(result.win.proportion)} [${pct(result.win.low)}-${pct(result.win.high)}]  ` +
    `draw ${pct(result.draw.proportion)}  loss ${pct(result.loss.proportion)}  ` +
    `| ${result.n} rollouts, ${result.passes} passes, mean ${result.meanPlies.toFixed(1)} plies ` +
    `(longest ${result.longestPlies}), truncated ${result.truncated} ` +
    `(${pct(result.truncatedFraction)}), ${(result.elapsedMs / 1000).toFixed(1)}s`
  );
}

export default function MaiaRolloutTestPage() {
  const [lines, setLines] = useState<string[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const log = (line: string) => {
      if (!cancelled) setLines((prev) => [...prev, line]);
    };
    const section = (title: string) => {
      log("");
      log(`== ${title} ==`);
    };

    (async () => {
      // ── 1. pure arithmetic, no model needed ────────────────────────────────
      // First because it needs no forward pass, so a broken interval or sampler
      // is on screen before the 93MB download finishes.
      section("Wilson intervals against hand-computed values");
      const wilsonCases: { count: number; n: number; low: string; high: string }[] = [
        { count: 30, n: 30, low: "88.6%", high: "100.0%" },
        { count: 15, n: 30, low: "33.2%", high: "66.8%" },
        { count: 100, n: 100, low: "96.3%", high: "100.0%" },
        { count: 50, n: 100, low: "40.4%", high: "59.6%" },
        { count: 150, n: 300, low: "44.4%", high: "55.6%" },
      ];
      for (const testCase of wilsonCases) {
        const got = wilsonInterval(testCase.count, testCase.n);
        const ok = pct(got.low) === testCase.low && pct(got.high) === testCase.high;
        log(
          `${verdict(ok)}  ${testCase.count}/${testCase.n} -> ` +
            `[${pct(got.low)}, ${pct(got.high)}]  want [${testCase.low}, ${testCase.high}]`,
        );
      }
      // The whole reason for Wilson over Wald, made visible.
      const perfect = wilsonInterval(30, 30);
      log(
        `${verdict(perfect.low < 1 && perfect.high === 1)}  30/30 is not a zero-width interval ` +
          `(Wald would say [100.0%, 100.0%])`,
      );

      section("value -> expected score mapping");
      const scoreCases: { label: string; value: number }[] = [
        { label: "even (measured -0.05)", value: -0.05 },
        { label: "start position (-0.1813)", value: -0.1813 },
        { label: "up a queen (+0.4583)", value: 0.4583 },
        { label: "down a queen (-0.5655)", value: -0.5655 },
        { label: "mate available (+1.0763)", value: 1.0763 },
      ];
      for (const testCase of scoreCases) {
        log(`${testCase.value >= 0 ? "+" : ""}${testCase.value.toFixed(4)} -> ` +
          `${pct(valueToExpectedScore(testCase.value))}  ${testCase.label}`);
      }
      log(
        `${verdict(Math.abs(valueToExpectedScore(-0.05) - 0.5) < 1e-9)}  the measured even value maps to exactly 50%`,
      );
      log(
        `${verdict(valueToExpectedScore(0.4583) > 0.7 && valueToExpectedScore(-0.5655) < 0.3)}  ` +
          `a queen either way lands outside 30-70%`,
      );
      log(
        `${verdict(valueToExpectedScore(1.0763) < 0.96)}  ` +
          `even a mate threat stays under 96% — the head is directional, not calibrated`,
      );

      try {
        // ── 2. batching correctness — the sharpest check here ────────────────
        section("batch rows vs the same positions evaluated alone");
        log("distinct positions on purpose: identical copies would hide a transposed row.");
        const fens = [START, MID_OPENING, AFTER_E4];
        const alone: MaiaEvaluation[] = [];
        for (const fen of fens) {
          if (cancelled) return;
          alone.push(await evaluateMaia(fen, MAIA_1500));
        }
        const batched = await evaluateMaiaBatch(fens.map((fen) => ({ fen, config: MAIA_1500 })));

        const policyDiff = (a: MaiaEvaluation, b: MaiaEvaluation) => {
          if (a.policy.length !== b.policy.length) return Infinity;
          let worst = 0;
          for (let i = 0; i < a.policy.length; i++) {
            if (a.policy[i].uci !== b.policy[i].uci) return Infinity;
            worst = Math.max(worst, Math.abs(a.policy[i].probability - b.policy[i].probability));
          }
          return worst;
        };

        let rowsAligned = true;
        fens.forEach((fen, i) => {
          const diff = policyDiff(alone[i], batched[i]);
          const valueDiff = Math.abs(alone[i].value - batched[i].value);
          if (!(diff < 1e-6 && valueDiff < 1e-6)) rowsAligned = false;
          log(
            `${verdict(diff < 1e-6 && valueDiff < 1e-6)}  row ${i} (${fen.split(" ")[1]} to move, ` +
              `${alone[i].policy.length} legal): max policy diff ${diff.toExponential(2)}, ` +
              `value diff ${valueDiff.toExponential(2)}`,
          );
        });
        // A row that matched a *different* position would mean the layout is wrong
        // even though every row above "passed" on its own.
        const crossed = policyDiff(alone[0], batched[1]);
        log(
          `${verdict(crossed === Infinity || crossed > 1e-3)}  row 1 does NOT match position 0 ` +
            `(diff ${crossed === Infinity ? "different moves entirely" : crossed.toExponential(2)})`,
        );
        log(rowsAligned ? "batching: row-aligned and numerically identical" : "batching: BROKEN — stop here");

        // ── 3. the sampler ──────────────────────────────────────────────────
        section("sampleFromPolicy");
        const { policy } = await evaluateMaia(MID_OPENING, MAIA_1500);
        log(
          `policy: ${policy.slice(0, 4).map((m) => `${m.uci} ${pct(m.probability)}`).join("  ")}  ` +
            `(+${policy.length - 4} more)`,
        );

        const argmax = sampleFromPolicy(policy, 0);
        log(`${verdict(argmax === policy[0].uci)}  T=0 returns the top move (${argmax})`);

        // T=1 must reproduce the policy itself. This is the check that would catch
        // a cumulative-sum walk that's off by one, or weights left unrenormalised.
        const draws = 6000;
        const rng = mulberry32(0x5eed);
        const seen = new Map<string, number>();
        for (let i = 0; i < draws; i++) {
          const uci = sampleFromPolicy(policy, 1, rng);
          seen.set(uci, (seen.get(uci) ?? 0) + 1);
        }
        let worstDrift = 0;
        for (const move of policy.slice(0, 5)) {
          const empirical = (seen.get(move.uci) ?? 0) / draws;
          worstDrift = Math.max(worstDrift, Math.abs(empirical - move.probability));
          log(`  ${move.uci}  policy ${pct(move.probability)}  sampled ${pct(empirical)}`);
        }
        log(
          `${verdict(worstDrift < 0.02)}  T=1 empirical frequencies track the policy ` +
            `(worst drift ${pct(worstDrift)} over ${draws} draws)`,
        );

        // Checked against what the sharpened distribution actually implies, not a
        // round number. p^20 over this policy leaves the top move ~95% of the
        // mass, so "nearly always, but not always" is the correct behaviour and a
        // stricter threshold would just have been wrong.
        const sharpWeights = policy.map((move) => move.probability ** (1 / 0.05));
        const sharpTotal = sharpWeights.reduce((a, b) => a + b, 0);
        const expectedTopShare = sharpWeights[0] / sharpTotal;
        const sharpRng = mulberry32(0x5eed);
        let topHits = 0;
        for (let i = 0; i < 500; i++) {
          if (sampleFromPolicy(policy, 0.05, sharpRng) === policy[0].uci) topHits += 1;
        }
        log(
          `${verdict(Math.abs(topHits / 500 - expectedTopShare) < 0.05)}  T=0.05 sharpens as the ` +
            `maths says: sampled ${pct(topHits / 500)} top move, distribution implies ${pct(expectedTopShare)}`,
        );

        // ── 4. mate in 1 ────────────────────────────────────────────────────
        // Read against Maia's own policy mass on the mate, not against 100%: if
        // the model only puts 90% there, occasional misses are correct sampling.
        section("mate in 1 (degenerate case)");
        const mateEval = await evaluateMaia(MATE_IN_1, MAIA_1500);
        const mateMass = mateEval.policy.find((m) => m.uci === MATING_MOVE)?.probability ?? 0;
        log(`Maia's own mass on ${MATING_MOVE} (Ra8#) at T=1: ${pct(mateMass)}`);
        log(`top moves: ${mateEval.policy.slice(0, 3).map((m) => `${m.uci} ${pct(m.probability)}`).join("  ")}`);

        // Budget trimmed from 120: a rollout that misses the mate here plays out a
        // rook-versus-three-pawns endgame, and that tail is not what's under test.
        const mate = await runMaiaRollouts({
          fen: MATE_IN_1,
          moverTier: TIER,
          n: 30,
          plyBudget: 40,
          onProgress: () => {},
        });
        log(summarize(mate));
        log(
          `${verdict(mate.win.proportion >= 0.7)}  wins dominate ` +
            `(a rate near 50% or 0% would mean a perspective/sign bug, not bad luck)`,
        );
        log(
          `${verdict(mate.meanPlies < 6)}  games end almost immediately ` +
            `(mean ${mate.meanPlies.toFixed(1)} plies)`,
        );

        // ── 5. perspective: one board, both sides to move ────────────────────
        section("perspective inversion (same board, whose turn flipped)");
        log("white is a rook up in both. the results must INVERT, not agree.");
        const asWhite = await runMaiaRollouts({
          fen: ROOK_UP_WHITE_TO_MOVE,
          moverTier: TIER,
          n: 30,
          plyBudget: 80,
        });
        log(`white to move (rook up)   ${summarize(asWhite)}`);
        if (cancelled) return;
        const asBlack = await runMaiaRollouts({
          fen: ROOK_UP_BLACK_TO_MOVE,
          moverTier: TIER,
          n: 30,
          plyBudget: 80,
        });
        log(`black to move (rook down) ${summarize(asBlack)}`);
        log(`${verdict(asWhite.rootTurn === "w" && asBlack.rootTurn === "b")}  rootTurn read off the FEN correctly`);
        log(
          `${verdict(asWhite.win.proportion > asBlack.win.proportion + 0.3)}  ` +
            `the rook-up side wins far more often than the rook-down side ` +
            `(${pct(asWhite.win.proportion)} vs ${pct(asBlack.win.proportion)})`,
        );

        // ── 6. lockstep bookkeeping ─────────────────────────────────────────
        // The compaction equivalent of the spec's masking check: rollouts of
        // different lengths share a batch, a finished one is never advanced again,
        // and no pass runs after the last one settles.
        section("lockstep + compaction bookkeeping");
        for (const [label, result] of [
          ["mate-in-1", mate],
          ["rook up", asWhite],
          ["rook down", asBlack],
        ] as const) {
          const budgeted = result.truncated > 0;
          const expectedPasses = result.longestPlies + (budgeted ? 1 : 0);
          log(
            `${verdict(result.passes === expectedPasses)}  ${label}: ${result.passes} passes for a ` +
              `longest rollout of ${result.longestPlies} plies` +
              `${budgeted ? " (+1 to bootstrap the truncated ones)" : ""} — no work after the last one settled`,
          );
          const total = result.win.count + result.draw.count + result.loss.count;
          log(`${verdict(total === result.n)}  ${label}: outcomes account for every rollout (${total}/${result.n})`);
        }
        // Only meaningful where the games genuinely differ in length. A forced mate
        // ends every rollout on the same ply, so asserting a spread there tests the
        // position, not the bookkeeping.
        log(
          `${verdict(asBlack.meanPlies < asBlack.longestPlies)}  rollouts of differing lengths shared ` +
            `a batch (rook down: mean ${asBlack.meanPlies.toFixed(1)} < longest ${asBlack.longestPlies}), ` +
            `and a settled one is never advanced again — it leaves the batch entirely`,
        );

        // ── 7. does it move with Stockfish? ─────────────────────────────────
        // Direction only. A tight numeric match would be suspicious — the premise
        // of the whole feature is that these two measures diverge.
        section("direction vs Stockfish (sign/rank, not numeric match)");
        const stockfish: EngineConfig = { type: "stockfish", label: "Stockfish 2800", elo: 2800 };
        const comparisons: { label: string; fen: string; cp: number | null; win: number }[] = [];
        for (const [label, fen] of [
          ["mover up a rook", MOVER_UP_A_ROOK],
          ["level rooks", LEVEL_ROOKS],
          ["mover down a rook", MOVER_DOWN_A_ROOK],
        ] as const) {
          if (cancelled) return;
          let last: number | null = null;
          await getMoveFor(fen, stockfish, (line) => {
            const score = parseSearchScore(line);
            if (score?.cp !== null && score?.cp !== undefined) last = score.cp;
            else if (score?.mate != null) last = score.mate > 0 ? 10000 : -10000;
          });
          const rollout = await runMaiaRollouts({ fen, moverTier: TIER, n: 30, plyBudget: 80 });
          comparisons.push({ label, fen, cp: last, win: rollout.win.proportion });
          log(`${label.padEnd(18)} cp ${String(last).padStart(6)}   rollout win ${pct(rollout.win.proportion)}   ${summarize(rollout)}`);
        }
        const ordered =
          comparisons.length === 3 &&
          comparisons[0].win > comparisons[1].win &&
          comparisons[1].win > comparisons[2].win;
        log(
          `${verdict(ordered)}  rollout win% ranks the three positions the same way Stockfish's cp does`,
        );

        // ── 8. a realistic middlegame, for the numbers the docs quote ───────
        section("realistic middlegame at the default settings");
        const middlegame = await runMaiaRollouts({
          fen: MID_OPENING,
          moverTier: TIER,
          n: 30,
          onProgress: (progress) => {
            if (progress.ply % 20 === 0) log(`  ...ply ${progress.ply}, ${progress.settled}/${progress.n} settled`);
          },
        });
        log(summarize(middlegame));
        log(`end reasons: ${JSON.stringify(middlegame.endReasons)}`);
        log(
          `${verdict(!middlegame.compromised)}  truncated fraction ${pct(middlegame.truncatedFraction)} ` +
            `is under the 15% mark where the interval stops meaning much`,
        );
        const sums =
          middlegame.win.proportion + middlegame.draw.proportion + middlegame.loss.proportion;
        log(`${verdict(Math.abs(sums - 1) < 1e-9)}  the three proportions sum to 1`);

        // Mismatched tiers, since the value-head probe showed the model prices a
        // rating gap and nothing else here exercises that path.
        section("mismatched tiers (1100 playing 1900)");
        const mismatched = await runMaiaRollouts({
          fen: MID_OPENING,
          moverTier: 1100,
          opponentTier: 1900,
          n: 30,
        });
        log(summarize(mismatched));
        log(`${verdict(mismatched.moverTier === 1100 && mismatched.opponentTier === 1900)}  both tiers carried through`);
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
      {"maia monte carlo rollouts (Task 14)\n"}
      {lines.length === 0 ? "fetching ~89MB model, this takes a moment...\n" : lines.join("\n") + "\n"}
      {done ? "\ndone" : "\nrunning..."}
    </pre>
  );
}
