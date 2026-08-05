"use client";

// Verification harness for the Bayesian rating estimator (Task 13). Unstyled on
// purpose, same as the other /dev pages — it's an instrument.
//
// The spec asks for this as scripts/verify-rating-posterior.mjs. It can't be:
// engineMaia.ts throws "Maia runs in the browser only" under Node and ORT
// resolves its wasm out of /ort/, so the checks have to run in a page. Drive it
// the same way as the Maia spike:
//
//   node scripts/cdp-verify.mjs "http://localhost:3000/dev/rating-test" done 600000 <port>
//
// Run it against a production build. Under `next dev` React StrictMode mounts
// effects twice, which doubles every forward pass here for no benefit.
//
// The trap this page exists to avoid: the estimator's generative model IS Maia,
// so feeding it Maia's own moves at a known bucket is a test it has no excuse to
// fail — and a plausible-looking posterior that converges on the wrong bucket is
// exactly what a mis-wired elo_self would produce.

import { Chess } from "chess.js";
import { useEffect, useRef, useState } from "react";

import {
  likelihoodsForMove,
  MAIA_RATING_BUCKETS,
  moveMutualInformation,
  policiesForAllBuckets,
  type RatingBucket,
} from "@/lib/analysis/maiaLikelihood";
import {
  createRatingEstimator,
  informationWeight,
  LIKELIHOOD_FLOOR,
  MIN_INFORMATION_NATS,
  REFERENCE_INFORMATION_NATS,
  READY_EFFECTIVE_PLIES,
  resolveOppoBucket,
  summarizePosterior,
  TEMPERING_EXPONENT,
  updateRatingEstimator,
  type RatingEstimatorState,
} from "@/lib/analysis/ratingPosterior";
import { eloToCategory, evaluateMaia, evaluateMaiaAt } from "@/lib/chess/engineMaia";
import type { MaiaEvaluation } from "@/lib/chess/engineMaia";

/** The side being rated. Deliberately not one of the three MAIA_PRESETS. */
const TRUE_BUCKET: RatingBucket = 1700;
/** The opponent actually sitting there — a real preset, so oppoBucket is exact. */
const OPPONENT = { type: "maia" as const, label: "Maia 1500", ratingTier: 1500 };
/** For check 4: an elo_oppo default that is flatly wrong. */
const WRONG_OPPO_BUCKET: RatingBucket = 1100;

/** Plies of game to generate. ~half are the rated side's own. */
const FIXTURE_PLIES = 80;
/** Two seeds, so "MAP landed one bucket off" can be told from seed noise. */
const FIXTURE_SEEDS = [20260805, 771];

const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

/**
 * Exactly one legal move, confirmed against chess.js rather than reasoned about:
 * black king a8, white rook b7, white king h1, black to move. Rb7 covers a7 (7th
 * rank) and b8 (b-file), and it's undefended because the white king is on h1 —
 * so Kxb7 (a8b7) is the only move, and black isn't in check, so this isn't
 * mate-or-stalemate dressed up as a forced move.
 *
 * The obvious construction is a corner mate, which gives *zero* legal moves and
 * quietly tests nothing. Count the moves, don't eyeball the board.
 */
const ONE_LEGAL_MOVE_FEN = "k7/1R6/8/8/8/8/8/7K b - - 0 1";

const TAU_SWEEP = [1, 0.5, TEMPERING_EXPONENT, 0.2];

function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

/** Deterministic RNG, so a fixture that shows something odd can be re-run. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function samplePolicy(policy: { uci: string; probability: number }[], rng: () => number): string {
  const roll = rng();
  let cumulative = 0;
  for (const move of policy) {
    cumulative += move.probability;
    if (roll <= cumulative) return move.uci;
  }
  return policy[policy.length - 1].uci;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

interface PlyRecord {
  fenBefore: string;
  playedUci: string;
  policies: MaiaEvaluation[];
  likelihoods: number[];
}

/**
 * Replays cached per-ply policies at an arbitrary tau. Mirrors
 * updateRatingEstimator's accumulation — the one bit of duplicated maths on this
 * page — so that the tau sweep costs arithmetic instead of 9 more forward passes
 * per ply per tau. Cross-checked against the real accumulator below; if that
 * check fails, nothing the sweep says is worth reading.
 */
function replay(
  records: PlyRecord[],
  oppoBucket: RatingBucket,
  tau: number,
  weightFn: (information: number) => number = informationWeight,
) {
  let state = createRatingEstimator(oppoBucket);
  const trace: { information: number; weight: number; state: RatingEstimatorState }[] = [];

  for (const record of records) {
    // summarizePosterior is the shipped read path, so the prior here is
    // normalised by exactly the same code the estimator uses.
    const prior = summarizePosterior(state).probabilities;
    const information = moveMutualInformation(record.policies, prior);
    const scored = record.likelihoods.some((l) => l > 0);
    const weight = scored ? weightFn(information) : 0;

    if (weight > 0) {
      const beta = tau * weight;
      state = {
        ...state,
        logPosterior: state.logPosterior.map(
          (logProbability, bucket) =>
            logProbability +
            beta * Math.log(Math.max(record.likelihoods[bucket], LIKELIHOOD_FLOOR)),
        ),
        effectivePlies: state.effectivePlies + weight,
        totalPlies: state.totalPlies + 1,
      };
    } else {
      state = { ...state, totalPlies: state.totalPlies + 1 };
    }
    trace.push({ information, weight, state });
  }
  return trace;
}

/** g_t for an arbitrary (I_min, I_ref) pair — the shipped one is informationWeight. */
function weightWith(iMin: number, iRef: number) {
  return (information: number) => (information < iMin ? 0 : Math.min(1, information / iRef));
}

type Trace = ReturnType<typeof replay>;

/**
 * First ply at which any single bucket passes 90%. The overconfidence tell:
 * Maia's own per-move separation between adjacent buckets is 1-3 points, so
 * near-certainty after a handful of plies is not something the evidence supports
 * however good the arithmetic looks.
 */
function ninetyAt(trace: Trace): number {
  for (let i = 0; i < trace.length; i++) {
    if (Math.max(...summarizePosterior(trace[i].state).probabilities) > 0.9) return i + 1;
  }
  return -1;
}

function row(label: string, trace: Trace): string {
  const final = summarizePosterior(trace[trace.length - 1].state);
  const reached = ninetyAt(trace);
  return (
    `  ${label.padEnd(20)} ${final.mapBucket}  ` +
    `${`${final.credibleInterval.low}-${final.credibleInterval.high}`.padEnd(11)} ` +
    `${pct(final.credibleInterval.coverage).padStart(6)} ` +
    `${final.effectivePlies.toFixed(2).padStart(6)} ` +
    `${pct(final.probabilities[MAIA_RATING_BUCKETS.indexOf(TRUE_BUCKET)]).padStart(7)} ` +
    `${pct(Math.max(...final.probabilities)).padStart(6)} ` +
    `${reached === -1 ? "never" : String(reached)}`
  );
}

const ROW_HEADER = "  constants             MAP  interval       cov     eff  P(true)  max-P  ply@90%";

export default function RatingTestPage() {
  const [lines, setLines] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    // StrictMode mounts effects twice in dev. The ORT session is serialised now
    // so a double run no longer throws, but it does double a minute of inference.
    if (started.current) return;
    started.current = true;

    let cancelled = false;
    const out: string[] = [];
    const log = (line: string) => {
      out.push(line);
      if (!cancelled) setLines([...out]);
    };

    (async () => {
      try {
        const oppoBucket = resolveOppoBucket(OPPONENT);

        // ── 0. the elo_oppo split, before anything is built on it ──
        //
        // docs/maia-notes.md's "rating responsiveness PASS" varied ratingTier,
        // which the old code fed to BOTH tensors. So it proved the *pair* is
        // consumed and never isolated either input. These three do.
        log("== 0. evaluateMaiaAt: are the two elo inputs independently wired? ==");

        const selfSweep: string[] = [];
        for (const bucket of MAIA_RATING_BUCKETS) {
          if (cancelled) return;
          const { policy } = await evaluateMaiaAt(AFTER_E4, eloToCategory(bucket), eloToCategory(1500));
          selfSweep.push(policy.map((m) => `${m.uci}:${m.probability.toFixed(6)}`).join(","));
          log(
            `  self=${bucket} oppo=1500  ` +
              policy.slice(0, 3).map((m) => `${m.uci} ${pct(m.probability)}`).join("  "),
          );
        }
        const selfDistinct = new Set(selfSweep).size;
        log(
          `${selfDistinct > 1 ? "PASS" : "FAIL"}  elo_self moves the policy ` +
            `(${selfDistinct}/9 distinct distributions with elo_oppo held at 1500)`,
        );
        log("");

        const oppoSweep: string[] = [];
        for (const bucket of MAIA_RATING_BUCKETS) {
          if (cancelled) return;
          const { policy } = await evaluateMaiaAt(AFTER_E4, eloToCategory(1500), eloToCategory(bucket));
          oppoSweep.push(policy.map((m) => `${m.uci}:${m.probability.toFixed(6)}`).join(","));
          log(
            `  self=1500 oppo=${bucket}  ` +
              policy.slice(0, 3).map((m) => `${m.uci} ${pct(m.probability)}`).join("  "),
          );
        }
        const oppoDistinct = new Set(oppoSweep).size;
        log(
          `${oppoDistinct > 1 ? "PASS" : "NOTE"}  elo_oppo ${
            oppoDistinct > 1 ? "moves" : "does NOT move"
          } the policy ` + `(${oppoDistinct}/9 distinct with elo_self held at 1500)`,
        );
        if (oppoDistinct === 1) {
          log(
            "      elo_oppo is inert at this position. Not a blocker — elo_self is " +
              "what the estimator sweeps — but it means resolveOppoBucket cannot " +
              "affect any result, and check 4 below passes for free.",
          );
        }
        log("");

        // Same numbers as before the split? The pre-refactor run of
        // /dev/maia-test recorded these, and docs/maia-notes.md has had them
        // since Task 3, so this is a real regression check on the refactor.
        log("== 0b. evaluateMaiaAt(fen, c, c) still reproduces the documented baseline ==");
        const baseline: Record<number, string> = {
          1100: "g8f6 31.9%  b8c6 23.8%  e7e5 6.8%",
          1500: "g8f6 29.3%  b8c6 25.8%  e7e5 7.0%",
          1900: "g8f6 32.6%  b8c6 25.8%  e7e5 8.3%",
        };
        for (const rating of [1100, 1500, 1900]) {
          if (cancelled) return;
          const viaWrapper = await evaluateMaia(AFTER_E4, {
            type: "maia",
            label: `Maia ${rating}`,
            ratingTier: rating,
          });
          const top3 = viaWrapper.policy
            .slice(0, 3)
            .map((m) => `${m.uci} ${pct(m.probability)}`)
            .join("  ");
          log(`${top3 === baseline[rating] ? "PASS" : "FAIL"}  elo ${rating}  ${top3}`);
          if (top3 !== baseline[rating]) log(`      wanted: ${baseline[rating]}`);
        }
        log("");

        // ── 3. no evidence, no claim (spec check 3) ──
        log("== 3. fresh estimator makes no claim ==");
        const fresh = createRatingEstimator(oppoBucket);
        const freshReport = summarizePosterior(fresh);
        const flat = freshReport.probabilities.every((p) => Math.abs(p - 1 / 9) < 1e-12);
        log(`${flat ? "PASS" : "FAIL"}  probabilities flat at 1/9 (${pct(freshReport.probabilities[0])} each)`);
        log(`${!freshReport.ready ? "PASS" : "FAIL"}  ready=false at 0 effective plies`);
        log(
          `NOTE  interval ${freshReport.credibleInterval.low}-${freshReport.credibleInterval.high} ` +
            `at ${pct(freshReport.credibleInterval.coverage)} coverage`,
        );
        log(
          "      The spec expects this to span all 9. It spans 8: seven flat buckets " +
            "is 77.8% and eight is 88.9%, so 80% coverage stops at eight. MAP on an " +
            "exactly flat posterior is also just an argmax tie-break. ready=false is " +
            "what actually stops the UI claiming anything, and it does.",
        );
        log("");

        // ── 2. one legal move (spec check 2) ──
        log("== 2. a position with one legal move carries no information ==");
        const forced = new Chess(ONE_LEGAL_MOVE_FEN);
        const forcedMoves = forced.moves({ verbose: true });
        log(`  legal moves at ${ONE_LEGAL_MOVE_FEN}: ${forcedMoves.length} (${forcedMoves.map((m) => m.lan).join(",")})`);
        if (forcedMoves.length !== 1) {
          log(`FAIL  fixture is wrong — wanted exactly 1 legal move, got ${forcedMoves.length}`);
        } else {
          const forcedPolicies = await policiesForAllBuckets(ONE_LEGAL_MOVE_FEN, oppoBucket);
          const forcedInfo = moveMutualInformation(forcedPolicies, new Array(9).fill(1 / 9));
          const forcedWeight = informationWeight(forcedInfo);
          log(`${forcedInfo < 1e-12 ? "PASS" : "FAIL"}  I(fen) = ${forcedInfo.toExponential(3)} nats`);
          log(`${forcedWeight === 0 ? "PASS" : "FAIL"}  g_t = ${forcedWeight}`);
        }
        log("");

        // ── the fixture, two ways ──
        //
        // Variant A is what Maia actually plays: getMaiaMove takes the arg-max,
        // and evaluateMaia feeds the mover's own tier to both tensors. Variant B
        // samples from evaluateMaiaAt(fen, 1700, oppoBucket) — the exact
        // distribution the estimator hypothesises. B is the "no excuse to miss
        // it" test; A is the honest in-app one, and it is *weaker* evidence,
        // because an arg-max move is the one all nine buckets are most likely to
        // agree on. Worth separating: if A drags and B converges, that's a
        // specific finding, not a mystery.
        async function buildFixture(sampleRated: boolean, seed: number) {
          const game = new Chess();
          const rng = mulberry32(seed);
          const plies: { fenBefore: string; playedUci: string }[] = [];

          while (!game.isGameOver() && game.history().length < FIXTURE_PLIES) {
            if (cancelled) return null;
            const ratedToMove = game.turn() === "w";
            const before = game.fen();
            let uci: string;

            if (ratedToMove && sampleRated) {
              const { policy } = await evaluateMaiaAt(
                before,
                eloToCategory(TRUE_BUCKET),
                eloToCategory(oppoBucket),
              );
              uci = samplePolicy(policy, rng);
            } else if (ratedToMove) {
              const { policy } = await evaluateMaia(before, {
                type: "maia",
                label: `Maia ${TRUE_BUCKET}`,
                ratingTier: TRUE_BUCKET,
              });
              uci = policy[0].uci; // arg-max: exactly what getMaiaMove returns
            } else {
              // The opponent always samples. Two arg-max engines are fully
              // deterministic and walk straight into a repetition loop, which
              // leaves too few rated plies to measure anything.
              const { policy } = await evaluateMaia(before, OPPONENT);
              uci = samplePolicy(policy, rng);
            }

            const applied = game.move({
              from: uci.slice(0, 2),
              to: uci.slice(2, 4),
              promotion: uci.length > 4 ? uci.slice(4, 5) : undefined,
            });
            if (ratedToMove) plies.push({ fenBefore: before, playedUci: applied.lan });
          }
          return plies;
        }

        /** One set of 9 passes per ply, cached so the tau sweep is free. */
        async function recordPlies(
          plies: { fenBefore: string; playedUci: string }[],
          forOppoBucket: RatingBucket,
        ) {
          const records: PlyRecord[] = [];
          for (const ply of plies) {
            if (cancelled) return null;
            const policies = await policiesForAllBuckets(ply.fenBefore, forOppoBucket);
            records.push({
              ...ply,
              policies,
              likelihoods: likelihoodsForMove(policies, ply.playedUci),
            });
          }
          return records;
        }

        function reportTrace(label: string, records: PlyRecord[], tau: number) {
          const trace = replay(records, oppoBucket, tau);
          const final = summarizePosterior(trace[trace.length - 1].state);
          log(
            `  ${label.padEnd(26)} MAP ${final.mapBucket}  ` +
              `[${final.credibleInterval.low}-${final.credibleInterval.high}] ` +
              `cov ${pct(final.credibleInterval.coverage)}  ` +
              `eff ${final.effectivePlies.toFixed(2)}/${final.totalPlies}  ` +
              `P(true)=${pct(final.probabilities[MAIA_RATING_BUCKETS.indexOf(TRUE_BUCKET)])}`,
          );
          return { trace, final };
        }

        log(`== fixture: Maia ${TRUE_BUCKET} vs ${OPPONENT.label}, oppoBucket resolves to ${oppoBucket} ==`);
        log(`${oppoBucket === 1500 ? "PASS" : "FAIL"}  resolveOppoBucket(${OPPONENT.label}) = ${oppoBucket}`);
        log(
          `NOTE  resolveOppoBucket on the Stockfish presets: ` +
            [1320, 1800, 2800]
              .map(
                (elo) =>
                  `${elo}->${resolveOppoBucket({ type: "stockfish", label: `SF ${elo}`, elo })}`,
              )
              .join("  ") +
            `  |  no rating -> ${resolveOppoBucket({ type: "stockfish", label: "SF" })}`,
        );
        log("");

        const fixtureB = await buildFixture(true, FIXTURE_SEEDS[0]);
        if (!fixtureB) return;
        log(`sampled fixture: ${fixtureB.length} rated plies generated`);
        const recordsB = await recordPlies(fixtureB, oppoBucket);
        if (!recordsB) return;

        // ── 1. self-consistency, through the real shipped accumulator ──
        log("");
        log(`== 1. self-consistency (sampled): does the posterior find ${TRUE_BUCKET}? ==`);
        log("   ply  I(nats)  g_t   eff   MAP   interval        P(true)  ready");
        let live = createRatingEstimator(oppoBucket);
        const liveInfo: number[] = [];
        for (let i = 0; i < fixtureB.length; i++) {
          if (cancelled) return;
          const prior = summarizePosterior(live).probabilities;
          const information = moveMutualInformation(recordsB[i].policies, prior);
          liveInfo.push(information);
          live = await updateRatingEstimator(live, fixtureB[i].fenBefore, fixtureB[i].playedUci);
          const report = summarizePosterior(live);
          log(
            `   ${String(i + 1).padStart(3)}  ${information.toFixed(4)}  ` +
              `${informationWeight(information).toFixed(2)}  ` +
              `${report.effectivePlies.toFixed(2).padStart(5)}  ` +
              `${report.mapBucket}  ` +
              `${`${report.credibleInterval.low}-${report.credibleInterval.high}`.padEnd(14)}  ` +
              `${pct(report.probabilities[MAIA_RATING_BUCKETS.indexOf(TRUE_BUCKET)]).padStart(6)}  ` +
              `${report.ready ? "yes" : "no"}`,
          );
        }
        const liveFinal = summarizePosterior(live);
        const bucketsOff = Math.abs(
          MAIA_RATING_BUCKETS.indexOf(liveFinal.mapBucket) -
            MAIA_RATING_BUCKETS.indexOf(TRUE_BUCKET),
        );
        log(
          `${liveFinal.mapBucket === TRUE_BUCKET ? "PASS" : "FAIL"}  ` +
            `MAP converged to ${liveFinal.mapBucket} (true ${TRUE_BUCKET}), ` +
            `${bucketsOff} bucket${bucketsOff === 1 ? "" : "s"} off`,
        );
        if (liveFinal.mapBucket !== TRUE_BUCKET) {
          log(
            "      Read this against the evidence ceiling below before touching a " +
              "constant. If the ceiling — every ply at full weight, tau=1, the most " +
              "this fixture can possibly claim — is also off by a bucket, then the " +
              "per-move signal genuinely doesn't resolve neighbours and no amount of " +
              "tuning fixes it. Cranking tau until MAP lands on 1700 would just be " +
              "fitting one fixture.",
          );
        }
        const covers =
          liveFinal.credibleInterval.low <= TRUE_BUCKET &&
          liveFinal.credibleInterval.high >= TRUE_BUCKET;
        log(
          `${covers ? "PASS" : "FAIL"}  interval ${liveFinal.credibleInterval.low}-` +
            `${liveFinal.credibleInterval.high} covers the truth`,
        );
        log("");

        // Does the cached replay agree with the real accumulator? Everything
        // below leans on it.
        log("== replay cross-check (validates the tau sweep below) ==");
        const replayed = replay(recordsB, oppoBucket, TEMPERING_EXPONENT);
        const replayFinal = summarizePosterior(replayed[replayed.length - 1].state);
        const agrees =
          replayFinal.mapBucket === liveFinal.mapBucket &&
          Math.abs(replayFinal.effectivePlies - liveFinal.effectivePlies) < 1e-9 &&
          replayFinal.probabilities.every((p, i) => Math.abs(p - liveFinal.probabilities[i]) < 1e-9);
        log(
          `${agrees ? "PASS" : "FAIL"}  cached replay at tau=${TEMPERING_EXPONENT} matches ` +
            `updateRatingEstimator over all ${recordsB.length} plies`,
        );
        log(`      (checked MAP, effectivePlies and all 9 probabilities to 1e-9)`);
        log("");

        // ── I(fen) instrumentation: what I_min / I_ref should actually be ──
        log("== I(fen) distribution — the basis for I_min and I_ref ==");
        const sortedInfo = [...liveInfo].sort((a, b) => a - b);
        log(
          `  n=${sortedInfo.length}  min ${sortedInfo[0].toFixed(4)}  ` +
            `p25 ${quantile(sortedInfo, 0.25).toFixed(4)}  ` +
            `median ${quantile(sortedInfo, 0.5).toFixed(4)}  ` +
            `p75 ${quantile(sortedInfo, 0.75).toFixed(4)}  ` +
            `max ${sortedInfo[sortedInfo.length - 1].toFixed(4)}`,
        );
        log(`  first 6 plies (book, expect low): ${liveInfo.slice(0, 6).map((i) => i.toFixed(4)).join("  ")}`);
        log(`  shipped I_min=${MIN_INFORMATION_NATS}  I_ref=${REFERENCE_INFORMATION_NATS}`);
        const skipped = liveInfo.filter((i) => i < MIN_INFORMATION_NATS).length;
        const capped = liveInfo.filter((i) => i >= REFERENCE_INFORMATION_NATS).length;
        log(
          `  at those constants: ${skipped}/${liveInfo.length} plies skipped, ` +
            `${capped}/${liveInfo.length} at full weight, ` +
            `mean g_t ${(liveInfo.reduce((a, i) => a + informationWeight(i), 0) / liveInfo.length).toFixed(3)}`,
        );
        log("");

        // ── the ceiling: what can this evidence say at all? ──
        //
        // No weighting, no tempering — every ply at full weight, tau=1. This is
        // the most the fixture can possibly claim, and it's the number that
        // separates "my constants are throwing signal away" from "the signal
        // isn't there". Nothing shippable, purely diagnostic.
        log("== evidence ceiling: g=1, tau=1 (naive Bayes, no discounting) ==");
        const ceiling = replay(recordsB, oppoBucket, 1, () => 1);
        const ceilingFinal = summarizePosterior(ceiling[ceiling.length - 1].state);
        log(ROW_HEADER);
        log(row("g=1 tau=1", ceiling));
        log(
          `  posterior: ` +
            MAIA_RATING_BUCKETS.map(
              (b, i) => `${b}:${pct(ceilingFinal.probabilities[i])}`,
            ).join("  "),
        );
        log(
          `  ranked: ` +
            MAIA_RATING_BUCKETS.map((b, i) => ({ b, p: ceilingFinal.probabilities[i] }))
              .sort((x, y) => y.p - x.p)
              .map((x) => x.b)
              .join(" > "),
        );
        log("");

        // ── constants, chosen against the measured distribution ──
        log("== (I_min, I_ref) x tau grid, over the same cached policies ==");
        log(ROW_HEADER);
        for (const [iMin, iRef] of [
          [0.005, 0.01],
          [0.005, 0.02],
          [0.005, 0.03],
          [0.01, 0.05],
          [0.02, 0.25], // the spec's original starting guesses, for comparison
          [MIN_INFORMATION_NATS, REFERENCE_INFORMATION_NATS],
        ] as const) {
          for (const tau of TAU_SWEEP) {
            const shipped =
              iMin === MIN_INFORMATION_NATS &&
              iRef === REFERENCE_INFORMATION_NATS &&
              tau === TEMPERING_EXPONENT;
            log(
              row(`I${iMin}/${iRef} t${tau}`, replay(recordsB, oppoBucket, tau, weightWith(iMin, iRef))) +
                (shipped ? "   <- shipped" : ""),
            );
          }
        }
        log("");

        // ── which ply does the display gate open on? ──
        log(`== display gate: READY_EFFECTIVE_PLIES = ${READY_EFFECTIVE_PLIES} ==`);
        const gateAt = replayed.findIndex((t) => summarizePosterior(t.state).ready);
        if (gateAt === -1) {
          log(`NOTE  gate never opened in ${replayed.length} rated plies`);
        } else {
          const atGate = summarizePosterior(replayed[gateAt].state);
          log(
            `  opens at rated ply ${gateAt + 1} — interval ${atGate.credibleInterval.low}-` +
              `${atGate.credibleInterval.high}, span ${
                (MAIA_RATING_BUCKETS.indexOf(atGate.credibleInterval.high) -
                  MAIA_RATING_BUCKETS.indexOf(atGate.credibleInterval.low)) +
                1
              }/9 buckets`,
          );
          log(`  interval span by rated ply: ` +
            replayed
              .map(
                (t) => {
                  const r = summarizePosterior(t.state);
                  return (
                    MAIA_RATING_BUCKETS.indexOf(r.credibleInterval.high) -
                    MAIA_RATING_BUCKETS.indexOf(r.credibleInterval.low) +
                    1
                  );
                },
              )
              .join(" "));
        }
        log("");

        // ── 4. sensitivity to a wrong elo_oppo (spec check 4) ──
        log(`== 4. same fixture scored with a deliberately wrong oppoBucket (${WRONG_OPPO_BUCKET}) ==`);
        const recordsWrong = await recordPlies(fixtureB, WRONG_OPPO_BUCKET);
        if (!recordsWrong) return;
        reportTrace(`oppo=${oppoBucket} (correct)`, recordsB, TEMPERING_EXPONENT);
        const wrongTrace = replay(recordsWrong, WRONG_OPPO_BUCKET, TEMPERING_EXPONENT);
        const wrongFinal = summarizePosterior(wrongTrace[wrongTrace.length - 1].state);
        log(
          `  ${`oppo=${WRONG_OPPO_BUCKET} (wrong)`.padEnd(26)} MAP ${wrongFinal.mapBucket}  ` +
            `[${wrongFinal.credibleInterval.low}-${wrongFinal.credibleInterval.high}] ` +
            `cov ${pct(wrongFinal.credibleInterval.coverage)}  ` +
            `eff ${wrongFinal.effectivePlies.toFixed(2)}/${wrongFinal.totalPlies}  ` +
            `P(true)=${pct(wrongFinal.probabilities[MAIA_RATING_BUCKETS.indexOf(TRUE_BUCKET)])}`,
        );
        log(
          `${wrongFinal.mapBucket === TRUE_BUCKET ? "PASS" : "NOTE"}  a wrong elo_oppo ` +
            `${wrongFinal.mapBucket === TRUE_BUCKET ? "does not" : "DOES"} drag the MAP off ` +
            `${TRUE_BUCKET} — ` +
            `${
              wrongFinal.mapBucket === TRUE_BUCKET
                ? '"fix to a default" is safe in practice'
                : "marginalising elo_oppo may be worth its 9x cost"
            }`,
        );
        log("");

        // ── arg-max variant: what the app actually feeds this ──
        log("== 1b. same check on arg-max moves (what getMaiaMove really plays) ==");
        const fixtureA = await buildFixture(false, FIXTURE_SEEDS[0]);
        if (!fixtureA) return;
        const recordsA = await recordPlies(fixtureA, oppoBucket);
        if (!recordsA) return;
        log(`  ${fixtureA.length} rated plies`);
        log(ROW_HEADER);
        log(row("arg-max shipped", replay(recordsA, oppoBucket, TEMPERING_EXPONENT)));
        log(row("arg-max g=1 t=1", replay(recordsA, oppoBucket, 1, () => 1)));
        log("");

        // ── second seed: is a one-bucket miss signal or noise? ──
        log(`== 1c. second sampled fixture (seed ${FIXTURE_SEEDS[1]}) ==`);
        const fixtureC = await buildFixture(true, FIXTURE_SEEDS[1]);
        if (!fixtureC) return;
        const recordsC = await recordPlies(fixtureC, oppoBucket);
        if (!recordsC) return;
        log(`  ${fixtureC.length} rated plies`);
        log(ROW_HEADER);
        log(row("seed2 shipped", replay(recordsC, oppoBucket, TEMPERING_EXPONENT)));
        log(row("seed2 g=1 t=1", replay(recordsC, oppoBucket, 1, () => 1)));
        const infoC = replay(recordsC, oppoBucket, TEMPERING_EXPONENT).map((t) => t.information);
        const sortedC = [...infoC].sort((a, b) => a - b);
        log(
          `  I(fen): min ${sortedC[0].toFixed(4)}  median ${quantile(sortedC, 0.5).toFixed(4)}  ` +
            `p75 ${quantile(sortedC, 0.75).toFixed(4)}  max ${sortedC[sortedC.length - 1].toFixed(4)}`,
        );
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
    <pre style={{ padding: "2rem", fontSize: 13, lineHeight: 1.6 }}>
      {"rating posterior verification (Task 13)\n\n"}
      {lines.length === 0 ? "fetching ~93MB model, this takes a moment...\n" : lines.join("\n") + "\n"}
      {done ? "\ndone" : "\nrunning..."}
    </pre>
  );
}
