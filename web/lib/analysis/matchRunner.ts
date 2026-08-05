// Plays one preset against another until the sequential test decides, or the
// game cap runs out.
//
// **Browser only.** Everything else in `lib/analysis/` is pure maths that runs
// under plain Node; this file is the exception, and deliberately the only one.
// `engineStockfish.ts` needs a real `Worker` and `engineMaia.ts` refuses to load
// outside a browser, so "a Node-side runner" cannot mean "a script that plays the
// games". The split is the same one `cdp-verify.mjs` already uses everywhere
// else in this repo: the page plays, a Node script drives and collects.
//
// No second game loop. Every game goes through `runModelGame`, exactly as the
// two live screens do — a match runner with its own copy of the rules would be a
// way to measure an engine that no user ever plays against.
//
// Spec: docs/specs/2026-08-05-sprt-engine-ratings.md

import { Chess } from "chess.js";

import { GameAbortedError, runModelGame } from "@/lib/chess/gameLoop";
import type { EngineConfig } from "@/lib/chess/types";

import { makeRng, OPENING_BOOK, pickOpening } from "./openingBook";
import { fitBradleyTerryDavidson } from "./ratingBT";
import { createSprt, DEFAULT_ALPHA, DEFAULT_BETA, PLACEHOLDER_GAMMA, outcomeFor, recordGame } from "./sprt";
import type { BradleyTerryFit, MatchGameResult, OpeningLine, SprtState } from "./types";

export interface SprtMatchConfig {
  /** The preset the hypotheses are stated about. */
  a: EngineConfig;
  b: EngineConfig;
  /** H0 gap, `a` minus `b`. Default 0 — "no real difference". */
  elo0?: number;
  /** H1 gap. Default 200 — the spec's "is the label directionally real" case. */
  elo1?: number;
  alpha?: number;
  beta?: number;
  /**
   * Davidson tie parameter. Defaults to the spec's placeholder guess; once real
   * games exist, take the fitted γ out of `ratings.json` and pass that instead.
   */
  gamma?: number;
  /** Rounded up to a whole colour-swapped pair. */
  maxGames?: number;
  book?: OpeningLine[];
  seed?: number;
  signal?: AbortSignal;
  onProgress?: (progress: MatchProgress) => void;
}

export interface MatchProgress {
  gamesPlayed: number;
  /** Plies played in the game currently running, book prefix excluded. */
  currentPly: number;
  currentOpening: string;
  sprt: SprtState;
  status: MatchStatus;
}

export type MatchStatus = "playing" | "decided" | "max-games" | "aborted" | "engine-error";

export interface SprtMatchResult {
  runId: string;
  /** Everything needed to re-run this, and nothing that can't be JSON'd. */
  config: {
    a: string;
    b: string;
    elo0: number;
    elo1: number;
    alpha: number;
    beta: number;
    gamma: number;
    maxGames: number;
    seed: number;
    bookSize: number;
  };
  games: MatchGameResult[];
  finalSprt: SprtState;
  ratings: BradleyTerryFit;
  /** elo(a) − elo(b). Anchor-independent, which is what makes it the headline. */
  deltaElo: number | null;
  deltaStderr: number | null;
  status: MatchStatus;
  /** False when an engine failed or the run was aborted part-way. */
  complete: boolean;
  error?: string;
  elapsedMs: number;
  startedAt: number;
}

/** Replay a book line to the position the engines actually start from. */
export function bookStartFen(line: OpeningLine): string {
  const chess = new Chess();
  // chess.js is the legality authority here as everywhere else, so a typo in the
  // book throws on the first game rather than quietly producing a different
  // opening than the one it is labelled with.
  for (const san of line.san) chess.move(san);
  return chess.fen();
}

function nominalElo(config: EngineConfig): number {
  return config.elo ?? config.ratingTier ?? 1500;
}

/**
 * Run the match.
 *
 * **The stopping rule is evaluated per game, but a colour-swapped pair is always
 * finished.** Two things are going on and they pull slightly apart. The
 * trinomial LLR is a per-game quantity — that is the test whose α and β are
 * being claimed — so `recordGame` runs after every game and stops accumulating
 * the moment a boundary is crossed. But stopping dead there can leave the sample
 * one game heavier in white, and cancelling first-move bias is the entire reason
 * the runner swaps colours. So the pair completes; the extra game lands in the
 * log for the rating fit and is ignored by the already-decided SPRT. Cost is at
 * most one game, and the alternative is a W/D/L count that is subtly skewed.
 */
export async function runSprtMatch(config: SprtMatchConfig): Promise<SprtMatchResult> {
  if (typeof window === "undefined") {
    throw new Error(
      "runSprtMatch runs in the browser only — Stockfish needs a Worker and Maia needs window. " +
        "Drive it through /dev/match-runner with scripts/sprt-run.mjs.",
    );
  }

  const {
    a,
    b,
    elo0 = 0,
    elo1 = 200,
    alpha = DEFAULT_ALPHA,
    beta = DEFAULT_BETA,
    gamma = PLACEHOLDER_GAMMA,
    maxGames = 200,
    book = OPENING_BOOK,
    seed = 20260805,
    signal,
    onProgress,
  } = config;

  if (a.label === b.label) throw new Error("a match needs two different presets");

  const startedAt = Date.now();
  const runId = `${a.label}-vs-${b.label}-${startedAt}`.replace(/\s+/g, "-").toLowerCase();
  const rng = makeRng(seed);
  const games: MatchGameResult[] = [];
  let sprt = createSprt({ a: a.label, b: b.label, elo0, elo1, alpha, beta, gamma, maxGames });
  let status: MatchStatus = "playing";
  let error: string | undefined;

  outer: while (games.length < maxGames) {
    const line = pickOpening(rng, book);
    const startFen = bookStartFen(line);

    for (const aIsWhite of [true, false]) {
      const white = aIsWhite ? a : b;
      const black = aIsWhite ? b : a;

      let ply = 0;
      try {
        const outcome = await runModelGame(
          white,
          black,
          () => {
            ply++;
            onProgress?.({
              gamesPlayed: games.length,
              currentPly: ply,
              currentOpening: line.id,
              sprt,
              status,
            });
          },
          // Nobody is watching, so the human-watchability pause goes to zero.
          // Stockfish's own `movetime` is NOT touched: Task 2 found search depth
          // constant across ELO, so a preset measured at 50ms is a different
          // engine than the one deployed at 500ms. That lever isn't available
          // however tempting the 10x looks.
          { moveDelayMs: 0, signal, startFen },
        );

        games.push({
          openingId: line.id,
          white: white.label,
          black: black.label,
          result: outcome.result,
          endReason: outcome.endReason,
          // runModelGame only reports the plies it played, so the book prefix is
          // prepended here — otherwise every logged game starts on move 4.
          moves: [...line.san, ...outcome.moves],
          timestamp: Date.now(),
          runId,
        });

        sprt = recordGame(sprt, outcomeFor(a.label, white.label, black.label, outcome.result));
      } catch (err) {
        if (err instanceof GameAbortedError) {
          status = "aborted";
          break outer;
        }
        // Not swallowed the way a KV write failure is: a silently broken engine
        // means a quietly wrong rating, which is worse than no rating. Keep the
        // completed games, stop, and mark the run incomplete.
        status = "engine-error";
        error = err instanceof Error ? err.message : String(err);
        break outer;
      }

      onProgress?.({
        gamesPlayed: games.length,
        currentPly: 0,
        currentOpening: line.id,
        sprt,
        status,
      });
    }

    if (sprt.decision !== "continue") {
      status = sprt.decision === "max-games" ? "max-games" : "decided";
      break;
    }
  }

  if (status === "playing") status = "max-games";

  const presetIds = [a.label, b.label];
  // γ is held at the SPRT's value rather than fitted. Two reasons: the spec's own
  // "rating fit and SPRT share one model, not two", and the fact that a
  // ~22-game pairing has nowhere near the data to estimate a tie parameter — a
  // noisy γ̂ would drag δ̂ with it. Fitting γ is the job of the pooled fit across
  // every pairing in `games-log.jsonl`, not of one match.
  const ratings = fitBradleyTerryDavidson(games, presetIds, b.label, nominalElo(b), { fixedGamma: gamma });
  const ra = ratings.ratings.find((r) => r.presetId === a.label);
  const rb = ratings.ratings.find((r) => r.presetId === b.label);

  return {
    runId,
    config: { a: a.label, b: b.label, elo0, elo1, alpha, beta, gamma, maxGames, seed, bookSize: book.length },
    games,
    finalSprt: sprt,
    ratings,
    deltaElo: ra?.rated && rb?.rated ? ra.elo - rb.elo : null,
    // `b` is the anchor, so `a`'s standard error *is* the gap's standard error.
    deltaStderr: ra?.rated ? ra.stderr : null,
    status,
    complete: status === "decided" || status === "max-games",
    error,
    elapsedMs: Date.now() - startedAt,
    startedAt,
  };
}
