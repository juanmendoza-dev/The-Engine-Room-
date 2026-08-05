import { Chess } from "chess.js";

import { evaluateMaia } from "./engineMaia";
import { getStockfishLines, parseUciMove } from "./engineStockfish";
import type { EngineConfig, EngineMove } from "./types";

// The policy mixture: a fourth engine that isn't a third model.
//
// Stockfish already searches and scores moves; Maia already predicts which move a
// human would play. This picks a move from Stockfish's shortlist of moves that
// don't lose, weighted toward whichever of those a human would actually play:
//
//     score(m) = α · winProb(cp_m) + β · log P_maia(m)
//
// arg-maxed, or sampled through a temperature. Nothing here trains or fine-tunes
// either model — both run exactly as they do on their own, and this is a third
// function that calls both and does floating-point arithmetic on the two outputs.
// That keeps it inside the project's "no training, ever" constraint by
// construction rather than by discipline.
//
// Spec: docs/specs/2026-08-05-policy-mixture-engine.md

/** `multiPv` when a config doesn't say. A starting guess, not a calibrated value. */
const DEFAULT_MULTI_PV = 8;
const DEFAULT_ALPHA = 1;
const DEFAULT_BETA = 1;
const DEFAULT_TEMPERATURE = 0;

/**
 * Lichess's fitted win-probability constant: a logistic regression of win
 * probability against Stockfish cp over real game outcomes.
 *
 * Treat it as a reasonable published curve, not one calibrated to this app. It
 * wasn't fit to this build (18, lite, single-threaded), and Lichess has revised
 * the model across Stockfish/NNUE versions.
 *
 * **There is a better option available, and it's now confirmed present.** The spec
 * listed Stockfish's own `info … wdl <w> <d> <l>` under `UCI_ShowWDL` as the
 * properly calibrated alternative — win/draw/loss fit to this exact network rather
 * than regressed over somebody else's games — but left "does this lite build
 * advertise it" as an open question. It does: `/dev/mixture-test` section B reads
 * back `option name UCI_ShowWDL type check default false`. So switching the
 * Stockfish half of this blend onto real WDL numbers is a live follow-up with no
 * unknowns left in front of it, not a maybe. Still deliberately not done here —
 * it changes what α weights, so it wants its own before/after calibration.
 */
const WIN_PROB_K = 0.00368208;

/**
 * Ceiling Stockfish's cp is clamped to before the logistic runs.
 *
 * Above ±3000 the logistic is already within 1e-5 of its asymptote, so clamping
 * costs nothing for the purpose of *choosing a move* — two crushing candidates
 * become indistinguishable on the Stockfish term and Maia decides between them,
 * which is what this engine is for. What the clamp buys is headroom: it leaves a
 * band above the cp range that only mate scores occupy.
 */
const MAX_EVAL_CP = 3000;

/**
 * Width of the band above `MAX_EVAL_CP` reserved for mate scores, so that every
 * mate outranks every cp evaluation and a shorter mate outranks a longer one.
 *
 * **The spec's original scheme did not survive measurement, and this replaces
 * it.** It mapped mate distance onto a synthetic cp of 100,000 minus the
 * distance, on the reasoning that "the logistic saturates long before this; sign
 * and ordering are what matter". Sign survives; ordering does not. `exp(-0.00368
 * · 99_995)` underflows, so `winProb` returns *exactly* 1.0 for every mate at any
 * distance, and mate-in-1 ties with mate-in-5 — at which point the stable sort
 * silently falls back to Stockfish's multipv order. `/dev/mixture-test`
 * section A catches it directly.
 *
 * **What this fix does and does not buy.** Ordering is now real: mate-in-1 scores
 * above mate-in-5 by about 6e-9 of win probability. That is enough to decide an
 * argmax when the Maia term ties, and nowhere near enough to survive it
 * otherwise — a `β · log P` difference is order 1. So the blend prefers a shorter
 * mate only among moves Maia finds equally likely, and **this engine does not
 * guarantee it takes the fastest mate available**. That's a property of blending a
 * bounded win probability against an unbounded log-probability, not something
 * constant-tuning can fix; a hard "mate ends the game, skip the blend" override
 * would, and is deliberately not built here because it would break the α=0
 * verification check and belongs in a spec of its own.
 */
const MATE_BAND = 1000;

/**
 * How far below Stockfish's worst reported line a union pull-in sits (see
 * `buildCandidates`). Any positive number works; what matters is that a move
 * Stockfish never evaluated can never outrank one it did, on the Stockfish term.
 */
const FALLBACK_CP_PENALTY = 300;

/**
 * Additive floor before renormalising Maia's probabilities. Load-bearing, not
 * hygiene — and specifically load-bearing for **β = 0**.
 *
 * `Math.log(0)` is `-Infinity`, and `0 * -Infinity` is `NaN`, not `0`. So "β is
 * zero, the log term can't matter" is exactly wrong: without this floor, one
 * candidate carrying zero Maia mass turns its whole score `NaN` the moment β
 * touches it, and `NaN` comparisons in an argmax misbehave silently instead of
 * throwing.
 */
const PROB_EPSILON = 1e-6;

/** Lichess's win-percent model, in the 0..1 form used here. */
export function winProbFromCp(cp: number): number {
  return 1 / (1 + Math.exp(-WIN_PROB_K * cp));
}

/**
 * A line's evaluation as a single cp number, mate scores included.
 *
 * `score cp` and `score mate` are **already relative to the side to move**, per
 * UCI — and Maia's policy is naturally mover-relative too, so nothing needs
 * flipping when the two are joined. Same class of bug `mirrorFen`/`mirrorMove`
 * exist to avoid in engineMaia.ts, just a different instance of it.
 */
export function scoreToCp(line: { cp?: number; mate?: number }): number {
  // Mate first: a line carrying both is malformed, and the mate is the stronger
  // claim. `mate 0` is not a thing for a side that still has a move, so it falls
  // through to the cp branch rather than getting a sign of zero.
  if (line.mate !== undefined && line.mate !== 0) {
    const distance = Math.min(Math.abs(line.mate), MATE_BAND);
    return Math.sign(line.mate) * (MAX_EVAL_CP + MATE_BAND - distance);
  }
  if (line.cp !== undefined) {
    return Math.max(-MAX_EVAL_CP, Math.min(MAX_EVAL_CP, line.cp));
  }
  return 0;
}

export interface MixtureCandidate {
  /** `from + to + promotion?`, e.g. `"e2e4"`, `"e7e8q"` — the join key both sides speak. */
  uci: string;
  /** Mover-relative cp. Synthetic for a mate score or a union pull-in. */
  cp: number;
  /** `winProbFromCp(cp)`. The Stockfish half of the blend. */
  winProb: number;
  /** Maia's probability over the **full legal set**, before narrowing. */
  policyProb: number;
  /** Renormalised over the candidate set and epsilon-floored. What scoring reads. */
  maiaProb: number;
  /** Stockfish's `multipv` rank, or null when the union rule pulled this move in. */
  multipv: number | null;
  /**
   * Depth this line was last reported at, null for a union pull-in.
   *
   * Carried through because it explains a real but rare surprise: **the highest-cp
   * candidate is not always Stockfish's `multipv 1`.** MultiPV lines don't finish
   * at equal depths, so the rank Stockfish assigned from its own still-evolving
   * search and the cp it last reported can fall in different orders. Observed once
   * — on `r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4` at
   * `MultiPV=8`, where rank 1 reported cp 25 and rank 3 reported cp 27. Rare, not
   * routine: `/dev/mixture-test` C1 measured 7/7 agreement across its corpus. With
   * the depth alongside it, that reads as the depth-inequality risk the spec listed
   * rather than as a parse bug.
   */
  depth: number | null;
  /** `α · winProb + β · log(maiaProb)`. */
  score: number;
}

export interface MixtureEvaluation {
  /** Every candidate considered, best blended score first. */
  candidates: MixtureCandidate[];
  /** The selected move, in UCI. */
  chosen: string;
  /**
   * Stockfish's own `multipv 1` move.
   *
   * Closer to "what Stockfish would have played" than `bestmove` is, since the
   * mixture never reads `bestmove` and limit-strength can move that token without
   * touching the evals. But **not** the same thing as the mixture's β=0 choice:
   * that's the argmax over `cp`, and because MultiPV lines don't finish at equal
   * depths, rank 1 is not always the highest cp reported. Measured, not
   * hypothetical — see `MixtureCandidate.depth`.
   */
  stockfishTop: string | null;
  /** The raw `bestmove` token, kept so that divergence is visible rather than assumed. */
  stockfishBestmove: string | null;
  /** Maia's argmax over the full legal set. The α=0 check compares against this. */
  maiaTop: string;
  /** Deepest depth any line reported — the evidence for what MultiPV costs at a fixed movetime. */
  depth: number | null;
  /** Parameters actually used, after defaults. */
  resolved: { multiPv: number; alpha: number; beta: number; temperature: number };
}

/**
 * Join Stockfish's shortlist with Maia's policy into one scored candidate set.
 *
 * Pure, and exported, so the verification page can re-score the same engine
 * outputs at different α/β without paying for another 500ms search — which is
 * what makes hand-calibration (spec step 1) practical at all.
 *
 * Three rules decide who gets in:
 *
 *  - **chess.js is the sole legality authority.** Stockfish's lines came out of
 *    its own search and Maia's policy is already filtered to legal moves, so both
 *    inputs *should* be legal — they're still intersected with
 *    `chess.moves({ verbose: true })` rather than trusted, because this is the one
 *    engine whose candidates arrive from two sources.
 *  - **A legal move outside Stockfish's top N is excluded.** The whole premise is
 *    "pick among moves Stockfish's search already vouched for," so a move it
 *    didn't shortlist is precisely what should be left out. This makes the engine
 *    "Maia restricted to what Stockfish vouched for" — *not* "Maia with a blunder
 *    filter over every legal move."
 *  - **One exception: Maia's single favourite move is pulled in anyway**, with a
 *    synthetic cp below Stockfish's worst reported line. Not a hedge — it's what
 *    makes "α=0 reproduces Maia's choice" an *exact* check instead of one that
 *    fails whenever Maia's pick happens to fall outside the N, for reasons that
 *    have nothing to do with a bug.
 */
export function buildCandidates(
  fen: string,
  lines: { multipv: number; uci: string; cp?: number; mate?: number; depth?: number | null }[],
  policy: { uci: string; probability: number }[],
  alpha: number,
  beta: number
): MixtureCandidate[] {
  const legal = new Set(
    new Chess(fen).moves({ verbose: true }).map((m) => `${m.from}${m.to}${m.promotion ?? ""}`)
  );

  // Keyed by uci and keeping the better rank. MultiPV lines have distinct root
  // moves by construction, so this is belt-and-braces against a duplicate rather
  // than a case that's expected to fire.
  const shortlist = new Map<string, { uci: string; cp: number; multipv: number; depth: number | null }>();
  for (const line of lines) {
    if (!legal.has(line.uci)) continue;
    const existing = shortlist.get(line.uci);
    if (existing && existing.multipv <= line.multipv) continue;
    shortlist.set(line.uci, {
      uci: line.uci,
      cp: scoreToCp(line),
      multipv: line.multipv,
      depth: line.depth ?? null,
    });
  }

  const policyProbs = new Map(policy.map((entry) => [entry.uci, entry.probability]));

  // `multipv: number | null` declared rather than inferred — the union pull-in
  // below is the only member with a null rank, and inference from the Map's values
  // would type it away.
  const picked: { uci: string; cp: number; multipv: number | null; depth: number | null }[] = [
    ...shortlist.values(),
  ];

  // The union exception. `policy` is sorted best-first by evaluateMaia.
  const maiaTop = policy[0]?.uci;
  if (maiaTop !== undefined && legal.has(maiaTop) && !shortlist.has(maiaTop)) {
    const worstCp = Math.min(...picked.map((c) => c.cp));
    picked.push({
      uci: maiaTop,
      cp: worstCp - FALLBACK_CP_PENALTY,
      multipv: null,
      depth: null,
    });
  }

  // Renormalise Maia's mass over this narrower set. Maia's own softmax is already
  // renormalised once, over the full legal set; this is the same operation one
  // level narrower. A legal move missing from Maia's ~1880-entry move table
  // entirely lands here as probability 0 rather than as a crash — understood to
  // be rare-to-never (docs/maia-notes.md), handled defensively regardless.
  const floored = picked.map((c) => (policyProbs.get(c.uci) ?? 0) + PROB_EPSILON);
  const total = floored.reduce((a, b) => a + b, 0);

  return picked
    .map((candidate, i) => {
      const winProb = winProbFromCp(candidate.cp);
      const maiaProb = floored[i] / total;
      const score = alpha * winProb + beta * Math.log(maiaProb);

      // Unreachable via the epsilon floor above; reachable through a NaN α or β
      // on a hand-built config. Worth throwing on, because the alternative is an
      // argmax that silently prefers whichever candidate it saw first.
      if (!Number.isFinite(score)) {
        throw new Error(
          `Mixture produced a non-finite score for ${candidate.uci} ` +
            `(α=${alpha}, β=${beta}, maiaProb=${maiaProb})`
        );
      }

      return {
        uci: candidate.uci,
        cp: candidate.cp,
        winProb,
        policyProb: policyProbs.get(candidate.uci) ?? 0,
        maiaProb,
        multipv: candidate.multipv,
        depth: candidate.depth,
        score,
      };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Pick one candidate. `temperature = 0` is argmax — deterministic, which is what
 * the verification checks need. Above 0 samples proportional to
 * `exp(score / T)`; higher flattens toward uniform, which is what stops repeated
 * self-play games at one config from all playing out identically.
 *
 * `rng` is injectable for the same reason `sampleFromPolicy` takes one: a seeded
 * generator makes "does temperature actually vary the choice" testable.
 */
export function selectMixtureMove(
  candidates: MixtureCandidate[],
  temperature: number,
  rng: () => number = Math.random
): MixtureCandidate {
  if (candidates.length === 0) throw new Error("selectMixtureMove called with no candidates");
  if (temperature <= 0) return candidates[0]; // buildCandidates already sorted by score

  // Subtract-the-max before exp, the same guard evaluateMaia's own softmax uses.
  // Dividing every weight by a constant leaves the normalised distribution
  // identical, and it stops a large β or a small T from underflowing every weight
  // to zero — which would leave nothing to sample from at all.
  const max = candidates[0].score;
  const weights = candidates.map((c) => Math.exp((c.score - max) / temperature));
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0) || !Number.isFinite(total)) return candidates[0];

  const threshold = rng() * total;
  let cumulative = 0;
  for (let i = 0; i < candidates.length; i++) {
    cumulative += weights[i];
    if (threshold < cumulative) return candidates[i];
  }
  // Only reachable through floating-point slack, or an rng() that returns 1.
  return candidates[candidates.length - 1];
}

/**
 * The full blend at one position: both engines' outputs, every candidate, and the
 * choice. `getMixtureMove` is the thin wrapper over this — the same split as
 * `evaluateMaia`/`getMaiaMove`, and for the same reason: the verification page
 * needs the intermediate numbers, and the game loop needs one move.
 *
 * **The two engine calls run concurrently, and there's no contention to worry
 * about.** Stockfish goes through its shared, serialised Worker queue; Maia runs
 * its own wasm session off a separate queue on the main thread. Neither call's
 * input depends on the other's output, so this costs `max(~500, ~35) ≈ 500ms`
 * instead of ~535ms serial.
 */
export async function evaluateMixture(
  fen: string,
  config: EngineConfig,
  onInfo?: (line: string) => void,
  rng: () => number = Math.random
): Promise<MixtureEvaluation> {
  const multiPv = config.multiPv ?? DEFAULT_MULTI_PV;
  const alpha = config.alpha ?? DEFAULT_ALPHA;
  const beta = config.beta ?? DEFAULT_BETA;
  const temperature = config.temperature ?? DEFAULT_TEMPERATURE;

  // A mixture config wants honest per-line evaluations, so its internal Stockfish
  // call deliberately runs uncapped (getStockfishLines treats a missing `elo` as
  // uncapped, unlike getStockfishMove). An `elo` set here would quietly cap it
  // again and leave calibration chasing a target tangled up with whatever
  // limit-strength does internally — silent enough to be worth saying out loud.
  if (process.env.NODE_ENV !== "production" && config.elo !== undefined) {
    console.warn(
      `Mixture config "${config.label}" sets elo ${config.elo}; that caps its ` +
        `internal Stockfish call with UCI_LimitStrength and makes α/β calibration ` +
        `meaningless. Leave elo unset on a mixture config.`
    );
  }

  const legalCount = new Chess(fen).moves().length;
  if (legalCount === 0) throw new Error("Mixture: no legal move at this position");

  const [stockfish, maia] = await Promise.all([
    getStockfishLines(fen, config, multiPv, onInfo),
    evaluateMaia(fen, config),
  ]);

  if (maia.policy.length === 0) throw new Error("Mixture: Maia returned no legal move");

  // Loud on purpose. The union rule means a parse failure here would *not* throw
  // on its own — it would quietly leave Maia's favourite as the only candidate and
  // degrade the whole engine to plain Maia, which looks like a working mixture
  // from the outside. Anything that empties the shortlist while legal moves exist
  // is a bug in the MultiPV parse or the engine handshake, not a position.
  if (stockfish.lines.length === 0) {
    throw new Error(
      `Mixture: Stockfish reported no scored lines at a position with ${legalCount} ` +
        `legal move(s) (bestmove ${stockfish.bestmove ?? "(none)"}). Check the MultiPV parse.`
    );
  }

  const candidates = buildCandidates(fen, stockfish.lines, maia.policy, alpha, beta);
  const chosen = selectMixtureMove(candidates, temperature, rng);

  const depths = stockfish.lines.map((l) => l.depth).filter((d): d is number => d !== null);

  return {
    candidates,
    chosen: chosen.uci,
    stockfishTop: stockfish.lines.find((l) => l.multipv === 1)?.uci ?? null,
    stockfishBestmove: stockfish.bestmove,
    maiaTop: maia.policy[0].uci,
    depth: depths.length > 0 ? Math.max(...depths) : null,
    resolved: { multiPv, alpha, beta, temperature },
  };
}

/**
 * Same contract as `getStockfishMove` and `getMaiaMove`, so `getMoveFor` and both
 * screens never learn that this one calls two engines.
 */
export async function getMixtureMove(
  fen: string,
  config: EngineConfig,
  onInfo?: (line: string) => void
): Promise<EngineMove> {
  const { chosen } = await evaluateMixture(fen, config, onInfo);
  return parseUciMove(chosen);
}
