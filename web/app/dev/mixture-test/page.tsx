"use client";

// Verification harness for the policy mixture (Task 15). Deliberately unstyled,
// same family as /dev/stockfish-test and /dev/maia-test.
//
// The mixture is unusually easy to fool yourself about, because the failure modes
// all return a perfectly legal move:
//
//  - a broken MultiPV parse leaves Maia's favourite as the only candidate, so the
//    engine silently degrades to plain Maia and still plays chess;
//  - a NaN score makes argmax return whichever candidate it happened to see
//    first, which also still plays chess;
//  - blending a 0..1 win probability against an unbounded log-probability with
//    the wrong sign or scale still plays chess.
//
// So "it made a move" is worth nothing here. The checks below are arranged
// cheapest-and-most-diagnostic first: section A is pure arithmetic with no engine
// call at all, and it's the section that catches the NaN bug.
//
// Spec: docs/specs/2026-08-05-policy-mixture-engine.md

import { Chess } from "chess.js";
import { useEffect, useState } from "react";

import {
  buildCandidates,
  evaluateMixture,
  selectMixtureMove,
  winProbFromCp,
  type MixtureCandidate,
} from "@/lib/chess/engineMixture";
import { getAdvertisedOptions, getStockfishLines } from "@/lib/chess/engineStockfish";
import { MIXTURE_PRESETS } from "@/lib/chess/engines";
import type { EngineConfig } from "@/lib/chess/types";

const BASE = MIXTURE_PRESETS[0];
const START_FEN = new Chess().fen();

/** Positions the legality sweep and the three checks run over. */
const CORPUS: { label: string; fen: string }[] = [
  { label: "start position", fen: START_FEN },
  { label: "open Italian", fen: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3" },
  { label: "closed middlegame", fen: "r1bq1rk1/pp2ppbp/2np1np1/2p5/2P1P3/2N1BN2/PP2BPPP/R2Q1RK1 w - - 4 10" },
  { label: "black to move (POV check)", fen: "rnbqkb1r/pppp1ppp/5n2/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 2 3" },
  { label: "king + pawn endgame", fen: "8/8/8/4k3/8/4K3/4P3/8 w - - 0 1" },
  { label: "rook endgame", fen: "8/8/4k3/8/8/4K3/8/R7 w - - 0 1" },
  { label: "queenless, many captures", fen: "r3k2r/pppb1ppp/2n1bn2/3pp3/3PP3/2N1BN2/PPPB1PPP/R3K2R w KQkq - 6 9" },
  // Kings two files apart, not adjacent. The first version of this fen had them on
  // e1/e2, which is an illegal position — chess.js still reported a legal move for
  // it while Stockfish returned `bestmove (none)`, and engineMixture's
  // "no scored lines but legal moves exist" guard is what caught the discrepancy.
  { label: "promotion available", fen: "8/3P4/8/8/8/8/8/4k1K1 w - - 0 1" },
  // In check with exactly three replies (Kxe2, Kd1, Kf1) — also the case where the
  // position has fewer legal moves than multiPv asks for. The first version of this
  // fen was Fool's Mate, i.e. *zero* legal moves, which tested something else.
  { label: "in check, 3 legal moves", fen: "4k3/8/8/8/8/8/4r3/4K3 w - - 0 1" },
  { label: "forced mate available", fen: "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1" },
];

/**
 * Candidates for the "close eval, human disagrees" position that makes the blend
 * visible. Scanned rather than hand-picked to one fen: whether a position actually
 * produces both a small cp gap *and* a Maia/Stockfish disagreement is a property of
 * the two models, not something you can tell by looking at a board. The first
 * attempt here was a quiet Italian position where both models picked the same move,
 * which makes for a demo that proves nothing.
 */
const EYEBALL_CANDIDATES: { label: string; fen: string }[] = [
  { label: "start position", fen: START_FEN },
  { label: "closed middlegame", fen: "r1bq1rk1/pp2ppbp/2np1np1/2p5/2P1P3/2N1BN2/PP2BPPP/R2Q1RK1 w - - 4 10" },
  { label: "rook endgame", fen: "8/8/4k3/8/8/4K3/8/R7 w - - 0 1" },
  { label: "quiet Italian", fen: "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4" },
];

/** "close in cp" for the eyeball position's report line. */
const CLOSE_CP = 40;

const cfg = (over: Partial<EngineConfig>): EngineConfig => ({ ...BASE, ...over });

/** Deterministic RNG, so "temperature varies the choice" is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const uciOf = (m: { from: string; to: string; promotion?: string }) =>
  `${m.from}${m.to}${m.promotion ?? ""}`;

function sanOf(fen: string, uci: string): string | null {
  try {
    return (
      new Chess(fen).move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci.slice(4, 5) : undefined,
      })?.san ?? null
    );
  } catch {
    return null;
  }
}

const pass = (ok: boolean) => (ok ? "PASS   " : "FAIL   ");
const n3 = (x: number) => x.toFixed(3);

export default function MixtureTestPage() {
  const [lines, setLines] = useState<string[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const log = (line: string) => {
      if (!cancelled) setLines((prev) => [...prev, line]);
    };

    (async () => {
      // ══ A. pure arithmetic, no engine call ══════════════════════════════════
      // Everything here is a pure function over hand-made inputs. It runs first
      // because it needs no 93MB download and no 500ms search, and because it's
      // the only section that can catch the NaN failure mode reliably — hoping a
      // real position happens to produce a zero-Maia-mass candidate is not a test.
      log("== A. pure arithmetic (no engines) ==");

      log(`${pass(winProbFromCp(0) === 0.5)}winProb(0) = ${winProbFromCp(0)} (must be exactly 0.5)`);
      const monotonic = [-2000, -500, -100, 0, 100, 500, 2000].map(winProbFromCp);
      log(
        `${pass(monotonic.every((v, i) => i === 0 || v > monotonic[i - 1]))}` +
          `winProb monotonic in cp: ${monotonic.map(n3).join(" < ")}`,
      );
      // Tolerance, not `===`: the logistic is symmetric in exact arithmetic but
      // `1 - f(300)` and `f(-300)` take different float paths and land a few ulps
      // apart. An exact check here fails for a reason that says nothing about the
      // engine, which is worse than no check.
      const symmetryErr = Math.abs(winProbFromCp(-300) - (1 - winProbFromCp(300)));
      log(
        `${pass(symmetryErr < 1e-12)}` +
          `winProb symmetric about 0: |winProb(-300) - (1 - winProb(300))| = ${symmetryErr.toExponential(2)}`,
      );

      // Mate ordering. The reason mates get a synthetic cp instead of a clamp to
      // 1.0 is that one MultiPV batch can hold several mating lines, and
      // mate-in-1 has to outrank mate-in-5.
      const mateSet = buildCandidates(
        START_FEN,
        [
          { multipv: 1, uci: "e2e4", mate: 5 },
          { multipv: 2, uci: "d2d4", mate: 1 },
          { multipv: 3, uci: "g1f3", cp: 900 },
          { multipv: 4, uci: "b1c3", mate: -2 },
        ],
        [
          { uci: "e2e4", probability: 0.25 },
          { uci: "d2d4", probability: 0.25 },
          { uci: "g1f3", probability: 0.25 },
          { uci: "b1c3", probability: 0.25 },
        ],
        1,
        0,
      );
      const mateOrder = mateSet.map((c) => c.uci);
      log(
        `${pass(mateOrder[0] === "d2d4" && mateOrder[1] === "e2e4" && mateOrder[3] === "b1c3")}` +
          `mate ordering (equal Maia mass, β=0): ${mateOrder.join(" > ")}` +
          `  — want mate-1 > mate-5 > cp900 > mate-(-2)`,
      );
      log(
        `       synthetic cp: ${mateSet
          .map((c) => `${c.uci}=${c.cp}`)
          .join(" ")}  winProb: ${mateSet.map((c) => c.winProb.toFixed(9)).join(" ")}`,
      );
      log(
        "       (the spec's original 100,000-based mapping FAILED this: the logistic " +
          "saturates to exactly 1.0, so every mate tied and the",
      );
      log(
        "        sort fell back to multipv order. The margin below is ~6e-9 — real, " +
          "but far too small to survive a β·logP term. This engine",
      );
      log("        does NOT guarantee it plays the fastest mate; see engineMixture.ts.)");

      // ── The NaN guard. Math.log(0) is -Infinity and 0 * -Infinity is NaN, so
      // "β is zero so the log term can't matter" is exactly backwards: without the
      // epsilon floor, one zero-mass candidate poisons its own score, and a NaN in
      // an argmax loses silently instead of throwing.
      const zeroMassLines = [
        { multipv: 1, uci: "e2e4", cp: 30 },
        { multipv: 2, uci: "d2d4", cp: 25 },
        { multipv: 3, uci: "g1f3", cp: 20 },
      ];
      // g1f3 is shortlisted by Stockfish but carries no Maia mass at all.
      const zeroMassPolicy = [
        { uci: "e2e4", probability: 0.6 },
        { uci: "d2d4", probability: 0.4 },
      ];
      for (const beta of [0, 1, 5]) {
        try {
          const set = buildCandidates(START_FEN, zeroMassLines, zeroMassPolicy, 1, beta);
          const zero = set.find((c) => c.uci === "g1f3");
          const allFinite = set.every((c) => Number.isFinite(c.score));
          const top = selectMixtureMove(set, 0).uci;
          log(
            `${pass(allFinite && zero !== undefined && zero.policyProb === 0)}` +
              `zero-Maia-mass candidate at β=${beta}: all scores finite=${allFinite}, ` +
              `g1f3 policyProb=${zero?.policyProb}, floored maiaProb=${zero ? zero.maiaProb.toExponential(2) : "—"}, ` +
              `argmax=${top}`,
          );
        } catch (err) {
          log(`FAIL   zero-Maia-mass candidate at β=${beta} threw: ${(err as Error).message}`);
        }
      }
      log(
        "       (at β=0 the argmax must be e2e4 — the best cp. If a NaN crept in, " +
          "argmax silently returns whichever candidate sorted first instead.)",
      );

      // The union pull-in must never beat a line Stockfish actually evaluated, on
      // the Stockfish term. Here Maia's favourite (a2a3) is outside the shortlist.
      const unionSet = buildCandidates(
        START_FEN,
        zeroMassLines,
        [
          { uci: "a2a3", probability: 0.9 },
          { uci: "e2e4", probability: 0.1 },
        ],
        1,
        0,
      );
      const pulled = unionSet.find((c) => c.uci === "a2a3");
      const realCps = unionSet.filter((c) => c.multipv !== null).map((c) => c.cp);
      log(
        `${pass(pulled !== undefined && pulled.multipv === null && pulled.cp < Math.min(...realCps))}` +
          `union pull-in: a2a3 present=${pulled !== undefined}, rank=${pulled?.multipv}, ` +
          `cp=${pulled?.cp} < worst real cp ${Math.min(...realCps)}`,
      );
      log(
        `${pass(selectMixtureMove(unionSet, 0).uci === "e2e4")}` +
          `union pull-in loses at β=0 (argmax=${selectMixtureMove(unionSet, 0).uci}, want e2e4)`,
      );
      const unionAlphaZero = buildCandidates(
        START_FEN,
        zeroMassLines,
        [
          { uci: "a2a3", probability: 0.9 },
          { uci: "e2e4", probability: 0.1 },
        ],
        0,
        1,
      );
      log(
        `${pass(selectMixtureMove(unionAlphaZero, 0).uci === "a2a3")}` +
          `union pull-in wins at α=0 (argmax=${selectMixtureMove(unionAlphaZero, 0).uci}, want a2a3)` +
          `  — this is the whole reason the union rule exists`,
      );

      // Temperature. Pure, so it's tested directly on one candidate set rather
      // than by paying for repeated 500ms searches: temperature only ever touches
      // selectMixtureMove, and re-drawing from one set isolates exactly that.
      const tempSet = buildCandidates(
        START_FEN,
        zeroMassLines,
        [
          { uci: "e2e4", probability: 0.5 },
          { uci: "d2d4", probability: 0.3 },
          { uci: "g1f3", probability: 0.2 },
        ],
        1,
        1,
      );
      const draws = (t: number, seed: number) => {
        const rng = mulberry32(seed);
        const counts = new Map<string, number>();
        for (let i = 0; i < 400; i++) {
          const uci = selectMixtureMove(tempSet, t, rng).uci;
          counts.set(uci, (counts.get(uci) ?? 0) + 1);
        }
        return counts;
      };
      const atZero = draws(0, 1);
      log(
        `${pass(atZero.size === 1)}T=0 is deterministic: ${atZero.size} distinct move(s) in 400 draws`,
      );
      // Only T >= 0.5 is asserted on. A very low T is *supposed* to look
      // deterministic: the score gaps here are ~0.3, so at T=0.05 the top move
      // takes exp(0.3/0.05) ≈ 400x the weight of the runner-up and wins ~400/400
      // draws. Demanding variation there would be demanding the sampler be wrong.
      for (const t of [0.05, 0.5, 2]) {
        const counts = draws(t, 7);
        const spread = [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([uci, c]) => `${uci}:${c}`)
          .join(" ");
        const asserted = t >= 0.5;
        log(
          `${asserted ? pass(counts.size > 1) : "       "}` +
            `T=${t} → ${counts.size} distinct in 400 — ${spread}` +
            `${asserted ? "" : "  (not asserted: sharp by design at this T)"}`,
        );
      }
      log(
        "       (if T>=0.5 showed 1 distinct move, temperature is dead code — the " +
          "reason repeated self-play games at one config wouldn't all diverge.)",
      );

      if (cancelled) return;

      // ══ B. MultiPV plumbing ════════════════════════════════════════════════
      log("");
      log("== B. MultiPV: is the knob real, what does it cost, does it stay honest? ==");

      try {
        const options = await getAdvertisedOptions();
        const advertised = options.find((o) => o.startsWith("option name MultiPV "));
        log(`${pass(Boolean(advertised))}${advertised ?? "MultiPV is NOT advertised by this build"}`);
        // Flagged in the spec as the properly-calibrated alternative to Lichess's
        // fitted constant. Reporting it either way settles the follow-up.
        const wdl = options.find((o) => o.startsWith("option name UCI_ShowWDL "));
        log(
          `       UCI_ShowWDL: ${wdl ?? "not advertised — so the cp→winProb logistic stays the only option"}`,
        );
      } catch (err) {
        log(`ERROR  reading advertised options: ${(err as Error).message}`);
      }

      if (cancelled) return;

      // Does MultiPV cost search depth at a fixed 500ms? Unmeasured in the spec.
      // A shallower line's cp is less trustworthy than a deeper one's, invisibly so.
      log("");
      log("   depth cost of MultiPV at a fixed 500ms movetime:");
      for (const fen of [CORPUS[1].fen, CORPUS[2].fen]) {
        for (const multiPv of [1, 8]) {
          if (cancelled) return;
          try {
            const { lines: got } = await getStockfishLines(fen, cfg({ elo: undefined }), multiPv);
            const depths = got.map((l) => l.depth);
            log(
              `     MultiPV ${String(multiPv).padStart(2)}  lines ${String(got.length).padStart(2)}  ` +
                `depth max ${Math.max(...depths.map((d) => d ?? 0))} min ${Math.min(...depths.map((d) => d ?? 0))}  ` +
                `${CORPUS.find((c) => c.fen === fen)?.label}`,
            );
          } catch (err) {
            log(`     ERROR  MultiPV ${multiPv}: ${(err as Error).message}`);
          }
        }
      }

      if (cancelled) return;

      // The spec's flagged open question: does UCI_LimitStrength perturb the
      // reported per-line cp, or only which line becomes `bestmove`? The internal
      // call sidesteps it by never setting limit-strength — but "sidestepped" is
      // not "answered", and this is the cheap way to answer it.
      log("");
      log("   MultiPV x UCI_LimitStrength — are the reported cp values still honest?");
      try {
        const fen = CORPUS[1].fen;
        const uncapped = await getStockfishLines(fen, cfg({ elo: undefined }), 5);
        const capped = await getStockfishLines(fen, cfg({ elo: 1320 }), 5);
        log(`     uncapped  ${uncapped.lines.map((l) => `${l.uci}:${l.cp ?? `#${l.mate}`}`).join(" ")}`);
        log(`     elo 1320  ${capped.lines.map((l) => `${l.uci}:${l.cp ?? `#${l.mate}`}`).join(" ")}`);
        log(
          `     bestmove uncapped=${uncapped.bestmove} capped=${capped.bestmove}  ` +
            `multipv-1 uncapped=${uncapped.lines[0]?.uci} capped=${capped.lines[0]?.uci}`,
        );
        log(
          "     (read as: if the cp lists match but the bestmove tokens differ, " +
            "limit-strength only picks a different line and the evals stay honest.)",
        );
      } catch (err) {
        log(`     ERROR  ${(err as Error).message}`);
      }

      if (cancelled) return;

      // ══ C. the three falsifiable checks ════════════════════════════════════
      log("");
      log("== C1. beta=0 follows Stockfish alone ==");
      log("   Asserted: the choice is the highest-cp candidate — the mixture's own");
      log("   contract at beta=0. Reported but NOT asserted: whether that equals");
      log("   Stockfish's multipv-1 line. Those two can differ honestly, because");
      log("   MultiPV lines don't finish at equal depths, so the rank Stockfish");
      log("   assigned and the cp it last reported aren't always in the same order.");
      log("   Also reported: multipv-1 vs the raw bestmove token, which limit-");
      log("   strength can move without touching any eval.");
      let rankAgree = 0;
      let rankTotal = 0;
      for (const { label, fen } of CORPUS.slice(0, 7)) {
        if (cancelled) return;
        try {
          const r = await evaluateMixture(fen, cfg({ alpha: 1, beta: 0, temperature: 0 }));
          const byCp = [...r.candidates].sort((a, b) => b.cp - a.cp);
          const contractOk = r.chosen === byCp[0].uci;
          const matchesRank = r.chosen === r.stockfishTop;
          rankTotal += 1;
          if (matchesRank) rankAgree += 1;
          const chosenDepth = r.candidates.find((c) => c.uci === r.chosen)?.depth;
          const rankDepth = r.candidates.find((c) => c.uci === r.stockfishTop)?.depth;
          log(
            `${pass(contractOk)}${label.padEnd(26)} chose ${r.chosen} (cp ${byCp[0].cp}, depth ${chosenDepth})` +
              `  sf#1 ${r.stockfishTop} (depth ${rankDepth})${matchesRank ? " =" : " ← DIFFERS"}` +
              `  bestmove ${r.stockfishBestmove}${r.stockfishTop !== r.stockfishBestmove ? " ← differs" : ""}`,
          );
        } catch (err) {
          log(`ERROR  ${label}: ${(err as Error).message}`);
        }
      }
      log(
        `       cp-argmax agreed with Stockfish's multipv-1 on ${rankAgree}/${rankTotal} positions. ` +
          `Anything short of ${rankTotal}/${rankTotal} is the depth-inequality`,
      );
      log("       risk from the spec showing up in practice, not a parse bug.");

      if (cancelled) return;

      log("");
      log("== C2. alpha=0 reproduces Maia's own choice, exactly ==");
      log('   (if this only matches "most of the time", the union rule is wrong —');
      log("    a real bug, not acceptable drift.)");
      for (const { label, fen } of CORPUS.slice(0, 6)) {
        if (cancelled) return;
        try {
          const r = await evaluateMixture(fen, cfg({ alpha: 0, beta: 1, temperature: 0 }));
          const agrees = r.chosen === r.maiaTop;
          const pulled = r.candidates.find((c) => c.uci === r.maiaTop)?.multipv === null;
          log(
            `${pass(agrees)}${label.padEnd(26)} chose ${r.chosen} (maia top ${r.maiaTop})` +
              `${pulled ? " ← pulled in by the union rule" : ""}`,
          );
        } catch (err) {
          log(`ERROR  ${label}: ${(err as Error).message}`);
        }
      }

      if (cancelled) return;

      log("");
      log("== C3. every returned move is chess.js-legal ==");
      let legalOk = 0;
      let legalTotal = 0;
      const zeroMassSeen: string[] = [];
      for (const { label, fen } of CORPUS) {
        if (cancelled) return;
        legalTotal += 1;
        try {
          const r = await evaluateMixture(fen, cfg({}));
          const legal = new Set(new Chess(fen).moves({ verbose: true }).map(uciOf));
          const ok = legal.has(r.chosen);
          if (ok) legalOk += 1;
          // Every candidate, not just the chosen one — an illegal candidate that
          // merely lost the argmax is still a bug waiting for a different α/β.
          const strays = r.candidates.filter((c) => !legal.has(c.uci)).map((c) => c.uci);
          for (const c of r.candidates) {
            if (c.policyProb === 0) zeroMassSeen.push(`${label}:${c.uci}`);
          }
          log(
            `${pass(ok && strays.length === 0)}${label.padEnd(26)} ${r.chosen}` +
              `${sanOf(fen, r.chosen) ? ` (${sanOf(fen, r.chosen)})` : ""}  ` +
              `${r.candidates.length}/${legal.size} candidates` +
              `${strays.length > 0 ? `  ILLEGAL CANDIDATES: ${strays.join(",")}` : ""}`,
          );
        } catch (err) {
          log(`ERROR  ${label}: ${(err as Error).message}`);
        }
      }
      log(`       ${legalOk}/${legalTotal} positions returned a legal move`);
      log(
        `       zero-Maia-mass candidates seen in the wild: ` +
          `${zeroMassSeen.length === 0 ? "none (section A covers the case synthetically)" : zeroMassSeen.join(" ")}`,
      );

      if (cancelled) return;

      // ══ D. eyeball the blend ═══════════════════════════════════════════════
      log("");
      log("== D. does the blend actually do what it's for? ==");
      log("   Scanning for a position that genuinely poses the question: the top two");
      log("   lines close in cp AND Maia preferring a different move than Stockfish.");

      let chosenCase: { label: string; fen: string; r: Awaited<ReturnType<typeof evaluateMixture>> } | null =
        null;
      for (const { label, fen } of EYEBALL_CANDIDATES) {
        if (cancelled) return;
        try {
          const r = await evaluateMixture(fen, cfg({ alpha: 1, beta: 1, temperature: 0 }));
          const byCp = [...r.candidates].sort((a, b) => b.cp - a.cp);
          const gap = byCp.length > 1 ? byCp[0].cp - byCp[1].cp : Infinity;
          const close = gap <= CLOSE_CP;
          const disagrees = r.stockfishTop !== r.maiaTop;
          log(
            `     ${label.padEnd(20)} cp gap ${String(gap).padStart(4)} ${close ? "close " : "wide  "}  ` +
              `sf ${r.stockfishTop} vs maia ${r.maiaTop} ${disagrees ? "disagree" : "agree   "}  ` +
              `${close && disagrees ? "<- qualifies" : ""}`,
          );
          if (close && disagrees && chosenCase === null) chosenCase = { label, fen, r };
        } catch (err) {
          log(`     ERROR  ${label}: ${(err as Error).message}`);
        }
      }

      if (chosenCase === null) {
        log("   No candidate qualified. The blend can't be eyeballed on these positions —");
        log("   add one where the two models actually disagree at a close eval.");
      } else {
        const { label, fen, r } = chosenCase;
        log("");
        log(`   using "${label}" — chose ${r.chosen} (${sanOf(fen, r.chosen) ?? "?"}) at alpha=1 beta=1 T=0`);
        log("   uci    san     rank   depth      cp   winProb   policyP    maiaP     score");
        for (const c of r.candidates) {
          log(
            `   ${c.uci.padEnd(6)} ${(sanOf(fen, c.uci) ?? "?").padEnd(7)} ` +
              `${(c.multipv === null ? "union" : `#${c.multipv}`).padEnd(6)} ` +
              `${String(c.depth ?? "—").padStart(5)} ` +
              `${String(c.cp).padStart(7)}   ${n3(c.winProb)}    ${n3(c.policyProb)}    ` +
              `${n3(c.maiaProb)}   ${c.score.toFixed(4)}`,
          );
        }
        log("   (depth column: unequal values are why cp order and rank order can differ.)");

        // How the choice moves as beta sweeps — the design goal ("follow Maia when
        // the eval gap is small, Stockfish once it's large") made visible. Pure
        // re-scoring of one search's output, so this costs nothing extra.
        log("");
        log("   beta sweep on the same search output (alpha=1, T=0):");
        for (const beta of [0, 0.001, 0.01, 0.05, 0.1, 0.5, 1, 5]) {
          const rescored: MixtureCandidate[] = buildCandidates(
            fen,
            r.candidates.map((c) => ({
              multipv: c.multipv ?? 99,
              uci: c.uci,
              cp: c.cp,
              depth: c.depth,
            })),
            r.candidates.map((c) => ({ uci: c.uci, probability: c.policyProb })),
            1,
            beta,
          );
          const top = selectMixtureMove(rescored, 0);
          log(
            `     beta ${String(beta).padEnd(5)} -> ${top.uci} (${sanOf(fen, top.uci) ?? "?"})` +
              `${top.uci === r.maiaTop ? "  [maia's pick]" : ""}` +
              `${top.uci === r.stockfishTop ? "  [stockfish's pick]" : ""}`,
          );
        }
        // The crossover has a closed form, so print it rather than leaving the
        // reader to bisect the sweep by eye. Maia's pick beats Stockfish's when
        // winProb_m + b*log_m > winProb_s + b*log_s, i.e. when
        // b > (winProb_s - winProb_m) / (log_m - log_s).
        const sfPick = r.candidates.find((c) => c.uci === r.stockfishTop);
        const maiaPick = r.candidates.find((c) => c.uci === r.maiaTop);
        if (sfPick && maiaPick) {
          const dWin = sfPick.winProb - maiaPick.winProb;
          const dLog = Math.log(maiaPick.maiaProb) - Math.log(sfPick.maiaProb);
          log("");
          log(
            `   exact crossover: beta = (winProb_sf - winProb_maia) / (logP_maia - logP_sf) = ` +
              `${dWin.toFixed(5)} / ${dLog.toFixed(3)} = ${(dWin / dLog).toFixed(5)}`,
          );
          log(
            "   That number is what calibration step 1 was after, and it is tiny for a " +
              "structural reason, not a quirk of this position:",
          );
          log(
            "   the logistic's slope at cp 0 is k/4 = 0.00092 per centipawn, so two moves " +
              "10cp apart differ by ~0.009 in win probability",
          );
          log(
            "   while their Maia log-probabilities differ by ~2. A win probability is " +
              "bounded in 0..1; a log-probability is not. So alpha:beta = 1:1 is",
          );
          log(
            "   nowhere near a neutral midpoint — expect a calibrated beta around " +
              "0.001-0.01, and read the shipped 1:1 preset as Maia-dominated.",
          );
        }
        log(
          "   None of the above is a strength claim. That needs " +
            "docs/specs/2026-08-05-sprt-engine-ratings.md's match harness to actually run.",
        );
      }

      if (!cancelled) setDone(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <pre style={{ padding: "2rem", fontSize: 13, lineHeight: 1.65 }}>
      {"policy mixture verification (Task 15)\n\n"}
      {lines.length === 0 ? "loading engines...\n" : lines.join("\n") + "\n"}
      {done ? "\ndone" : "\nrunning..."}
    </pre>
  );
}
