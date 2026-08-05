"use client";

import type { MaiaRolloutResult, RolloutProgress } from "@/lib/chess/maiaRollout";

export type OddsStatus = "idle" | "running" | "done" | "failed";

export interface OddsState {
  status: OddsStatus;
  result: MaiaRolloutResult | null;
  progress: RolloutProgress | null;
  error: string | null;
  /**
   * Position these numbers describe. The caller compares it against the live FEN
   * and shows nothing when they differ — a result that lands after the player has
   * moved is about a position that no longer exists, and displaying it anyway
   * would be the most misleading thing this component could do.
   */
  forFen: string | null;
}

export const IDLE_ODDS: OddsState = {
  status: "idle",
  result: null,
  progress: null,
  error: null,
  forFen: null,
};

interface Props {
  odds: OddsState;
  /** Rating Maia plays the player's side at. */
  moverTier: number;
  /** Rating it plays the opponent at. */
  opponentTier: number;
  /** True when `moverTier` came from the live rating read rather than the default. */
  tierFromRatingRead: boolean;
  /** False while the opponent is thinking, the game is over, or a run is going. */
  canRun: boolean;
  onRun: () => void;
  onCancel: () => void;
}

const pct = (value: number) => `${Math.round(value * 100)}%`;

/**
 * The whole UI surface of the rollouts: three numbers, each with the interval it
 * actually earned, and the count they came from.
 *
 * Deliberately not a chart and not an eval bar. Two reasons, one from the spec and
 * one from this app's own history: the spec scopes this to "three percentages, the
 * interval, and N", and a needle-on-a-scale would read as an authoritative
 * evaluation — which this isn't. It's what happened in N sampled games, and the
 * honest presentation is the number next to its uncertainty (same argument as
 * docs/design/ink-and-bone-notes.md's retired "Live · engines coupled" badge, and
 * the same reason RatingReadout shows a band rather than a point).
 *
 * The wording is load-bearing too. "How 30 games from here ended" is a claim this
 * can back. "Your chance of winning" is not: Maia imitates human play at a rating,
 * these are its own samples of itself, and self-play at dozens of plies is a
 * distribution nobody has checked against real games.
 */
export function OddsReadout({
  odds,
  moverTier,
  opponentTier,
  tierFromRatingRead,
  canRun,
  onRun,
  onCancel,
}: Props) {
  const { status, result, progress, error } = odds;

  return (
    <div className="mt-6">
      <h2 className="text-er-dim mb-2 flex items-center gap-2 font-mono text-[11px] tracking-[0.2em] uppercase">
        Odds from here
        {status === "running" && <span className="er-lamp h-1.5 w-1.5 rounded-full" />}
      </h2>

      {status === "running" ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="text-er-dim font-mono text-[13px] tabular-nums">
            {progress ? `${progress.settled} of ${progress.n} settled · ply ${progress.ply}` : "starting…"}
          </p>
          <button
            onClick={onCancel}
            className="border-er-line text-er-dim hover:border-er-accent hover:text-er-accent cursor-pointer border px-3 py-1 font-mono text-[11px] tracking-[0.16em] uppercase transition-colors"
          >
            Stop
          </button>
        </div>
      ) : (
        <button
          onClick={onRun}
          disabled={!canRun}
          className="border-er-line text-er-text hover:border-er-accent hover:text-er-accent cursor-pointer border px-4 py-2 font-mono text-[11px] tracking-[0.16em] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-er-line disabled:hover:text-er-text"
        >
          {result ? "Play it out again" : "Play it out 30×"}
        </button>
      )}

      {status === "idle" && !result && (
        // Said up front, because a 30-second freeze nobody warned you about reads
        // as a hung page. Maia has no Worker, so this genuinely does occupy the tab.
        <p className="text-er-dim mt-2 font-mono text-[10px] tracking-[0.14em] uppercase">
          ~30s of Maia playing itself, in this tab
        </p>
      )}

      {status === "failed" && (
        <p className="text-er-accent mt-2 text-[13px]">{error ?? "The rollouts stopped early."}</p>
      )}

      {result && status !== "running" && (
        <>
          <dl className="mt-3 max-w-[320px] font-mono text-[13px] tabular-nums">
            {(
              [
                ["Win", result.win],
                ["Draw", result.draw],
                ["Loss", result.loss],
              ] as const
            ).map(([label, estimate]) => (
              <div key={label} className="border-er-line flex items-baseline gap-3 border-b py-1.5">
                <dt className="text-er-dim w-[46px] text-[11px] tracking-[0.16em] uppercase">
                  {label}
                </dt>
                <dd className="text-er-text w-[52px] text-right text-[15px]">
                  {pct(estimate.proportion)}
                </dd>
                <dd className="text-er-dim text-[11px]">
                  likely {pct(estimate.low)}–{pct(estimate.high)}
                </dd>
              </div>
            ))}
          </dl>

          <p className="text-er-dim mt-2 font-mono text-[10px] leading-relaxed tracking-[0.14em] uppercase">
            {result.n} games · Maia {moverTier}
            {tierFromRatingRead ? " (your read)" : ""} vs {opponentTier} ·{" "}
            {(result.elapsedMs / 1000).toFixed(0)}s
            {result.truncated > 0 && ` · ${result.truncated} unresolved`}
          </p>

          {result.compromised && (
            // Past this much bootstrapping the interval is describing the value
            // head's guesswork more than the games that were actually played.
            <p className="text-er-accent mt-2 text-[12px] leading-snug">
              {pct(result.truncatedFraction)} of these hit the {result.longestPlies}-ply cap and were
              scored by estimate, not played out — treat the spread as optimistic.
            </p>
          )}

          <p className="text-er-dim mt-2 text-[12px] leading-snug">
            How {result.n} games from this position ended with Maia playing both sides. Not an engine
            evaluation — what tends to happen at this rating, which is a different question.
          </p>
        </>
      )}
    </div>
  );
}
