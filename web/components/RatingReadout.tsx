"use client";

import { useSyncExternalStore } from "react";

import { MAIA_RATING_BUCKETS } from "@/lib/analysis/maiaLikelihood";
import type { RatingReport } from "@/lib/analysis/ratingPosterior";
import { getMaiaLoadState, subscribeMaiaLoad } from "@/lib/chess/engineMaia";

interface Props {
  /** Null before the first of the player's moves has been scored. */
  report: RatingReport | null;
  /** True while the 9 forward passes for the latest ply are still running. */
  working: boolean;
}

/**
 * The whole UI surface of the rating estimator: one line, and a bar that shows
 * the credible interval as a band rather than a point.
 *
 * Everything about how this is worded comes from the lesson in
 * docs/design/ink-and-bone-notes.md, "Header scoreboard" — the badge that got
 * retired wasn't ugly, it was untrue. So:
 *
 *  - Below the display gate it says it's still reading, and nothing else. Not a
 *    faint number, not a wide interval, nothing a viewer could screenshot.
 *  - Past the gate the MAP bucket never appears without its interval next to it.
 *    A bare number is the exact thing that badge was killed for.
 *  - It says "plays most like", never "your rating". What the posterior actually
 *    measures is which bucket's move distribution you resemble, which correlates
 *    with rating and isn't the same thing — and the estimator can't tell an
 *    unusual repertoire from a weaker one.
 */
export function RatingReadout({ report, working }: Props) {
  // Maia is the scoring model whoever the opponent is, so against Stockfish the
  // ~93MB fetch starts on the player's first move and MaiaLoadNotice — which is
  // gated on a Maia *opponent* — never explains it. Saying which wait this is
  // costs one line and stops a 30s pause reading as a broken feature.
  const load = useSyncExternalStore(subscribeMaiaLoad, getMaiaLoadState, getMaiaLoadState);
  const modelPending = load.status === "downloading" || load.status === "initializing";

  const gathering = !report || !report.ready;

  return (
    <div className="mt-6">
      <h2 className="text-er-dim mb-2 flex items-center gap-2 font-mono text-[11px] tracking-[0.2em] uppercase">
        Rating read
        {working && <span className="er-lamp h-1.5 w-1.5 rounded-full" />}
      </h2>

      {gathering ? (
        <p className="text-er-dim font-mono text-[13px]">
          {modelPending ? (
            <>
              Loading the move model
              <span className="tracking-[0.2em]">…</span>
            </>
          ) : (
            <>
              Reading your moves
              <span className="tracking-[0.2em]">…</span>
            </>
          )}
          {report && report.totalPlies > 0 && (
            <span className="ml-2 opacity-70">
              {report.effectivePlies.toFixed(1)} effective plies of {report.totalPlies}
            </span>
          )}
        </p>
      ) : (
        <>
          <p className="text-[15px] leading-snug">
            <span className="text-er-dim">Plays most like a </span>
            <span className="font-display-black text-er-text text-[19px] tracking-[-0.01em]">
              {report.mapBucket}
            </span>
            <span className="text-er-dim">
              {" "}
              · likely {report.credibleInterval.low}–{report.credibleInterval.high}
            </span>
          </p>

          <IntervalBar report={report} />

          <p className="text-er-dim mt-2 font-mono text-[10px] tracking-[0.16em] uppercase">
            {Math.round(report.credibleInterval.coverage * 100)}% credible ·{" "}
            {report.effectivePlies.toFixed(1)} effective plies of {report.totalPlies}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Nine cells, the interval filled and the MAP bucket picked out. Deliberately a
 * band and not a meter: the point being communicated is width, and a single
 * needle on a scale would say the opposite of what the numbers support.
 */
function IntervalBar({ report }: { report: RatingReport }) {
  const low = MAIA_RATING_BUCKETS.indexOf(report.credibleInterval.low);
  const high = MAIA_RATING_BUCKETS.indexOf(report.credibleInterval.high);

  return (
    <div className="mt-2 max-w-[320px]">
      <div className="flex gap-[2px]">
        {MAIA_RATING_BUCKETS.map((bucket, i) => {
          const inside = i >= low && i <= high;
          const isMap = bucket === report.mapBucket;
          return (
            <div
              key={bucket}
              title={`${bucket}: ${(report.probabilities[i] * 100).toFixed(1)}%`}
              className={`h-2 flex-1 border ${
                isMap
                  ? "border-er-accent bg-er-accent"
                  : inside
                    ? "border-er-line bg-er-dim"
                    : "border-er-line bg-transparent"
              }`}
            />
          );
        })}
      </div>
      <div className="text-er-dim mt-1 flex justify-between font-mono text-[10px] tracking-[0.1em]">
        <span>{MAIA_RATING_BUCKETS[0]}</span>
        <span>{MAIA_RATING_BUCKETS[MAIA_RATING_BUCKETS.length - 1]}</span>
      </div>
    </div>
  );
}
