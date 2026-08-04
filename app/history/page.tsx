"use client";

// The archive. A client component on purpose: the default storage adapter is
// localStorage, which only exists in the browser — so the list is fetched
// after mount, never at build time. That's also why this page needs no
// `export const dynamic = "force-dynamic"`: the prerendered shell contains no
// game data to go stale (deployment.md §4 has the longer story).

import { useEffect, useState } from "react";

import { TransitionLink } from "@/components/PageTransition";
import { KV_ENABLED, listGames } from "@/lib/games/store";
import type { GameRecord } from "@/lib/games/types";

const REASON_COPY: Record<string, string> = {
  checkmate: "checkmate",
  stalemate: "stalemate",
  "draw-repetition": "threefold repetition",
  "draw-50move": "fifty-move rule",
  "draw-insufficient": "insufficient material",
};

const MODE_COPY: Record<GameRecord["mode"], string> = {
  "model-1v1": "Model 1v1",
  "user-1v1": "User 1v1",
};

function winnerLine(game: GameRecord): string {
  if (game.result === "1-0") return `${game.white.label} wins`;
  if (game.result === "0-1") return `${game.black.label} wins`;
  return "Draw";
}

export default function HistoryPage() {
  // null = still reading the store; [] = read fine, genuinely no games.
  const [games, setGames] = useState<GameRecord[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    // listGames never throws — a broken store reads as an empty list.
    void listGames(50).then((records) => {
      if (!cancelled) setGames(records);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="relative z-1 mx-auto w-full max-w-[1180px] px-8 pt-10 pb-16">
      <h1 className="font-display-black mb-1 text-[clamp(32px,4vw,44px)] leading-tight tracking-[-0.02em] uppercase">
        History
      </h1>
      <p className="text-er-dim mb-2 text-[17px]">
        Every finished game, on the record{KV_ENABLED ? "." : " — in this browser."}
      </p>
      {/* Be honest about scope: a local ledger is not a global one. */}
      <p className="text-er-dim mb-8 font-mono text-[11px] tracking-[0.18em] uppercase">
        {KV_ENABLED
          ? "Shared archive · logged from every visitor"
          : "Local ledger · games played in this browser only"}
      </p>

      {games === null && (
        <p className="text-er-dim flex items-center gap-2 font-mono text-[11px] tracking-[0.18em] uppercase">
          <span className="er-lamp h-2 w-2 rounded-full" />
          Reading the ledger…
        </p>
      )}

      {games !== null && games.length === 0 && (
        <div className="border-er-line bg-er-surface border px-6 py-8">
          <h2 className="font-display-black text-[22px] tracking-[-0.01em] uppercase">
            Nothing on the record yet
          </h2>
          <p className="text-er-dim mt-2 mb-5 text-[15px]">
            Finished games land here automatically. Set two engines loose and come back.
          </p>
          <TransitionLink
            href="/model-1v1"
            className="border-er-accent text-er-accent hover:bg-er-accent hover:text-er-bg inline-block border px-6 py-2.5 font-mono text-[12px] tracking-[0.16em] uppercase transition-colors"
          >
            Run a Model 1v1 game
          </TransitionLink>
        </div>
      )}

      {games !== null && games.length > 0 && (
        <>
          <h2 className="text-er-dim mb-2 font-mono text-[11px] tracking-[0.2em] uppercase">
            Games · {games.length} on record · newest first
          </h2>
          <ol className="border-er-line divide-er-line bg-er-surface2 divide-y border">
            {games.map((g) => (
              <li key={g.id} className="flex flex-wrap items-baseline gap-x-6 gap-y-1 px-5 py-4">
                <div className="min-w-[220px] flex-[1_1_260px]">
                  <p className="text-[16px] font-semibold tracking-[-0.01em]">
                    {g.white.label} <span className="text-er-dim font-normal">vs</span>{" "}
                    {g.black.label}
                  </p>
                  <p className="text-er-dim mt-0.5 font-mono text-[11px] tracking-[0.14em] uppercase">
                    {MODE_COPY[g.mode] ?? g.mode} · {g.moves.length} plies
                  </p>
                </div>
                <div className="min-w-[180px] flex-[1_1_200px]">
                  <p className="text-er-accent font-mono text-[13px]">
                    {g.result} · {winnerLine(g)}
                  </p>
                  <p className="text-er-dim mt-0.5 font-mono text-[11px] tracking-[0.14em] uppercase">
                    by {REASON_COPY[g.endReason] ?? g.endReason}
                  </p>
                </div>
                <p className="text-er-dim ml-auto font-mono text-[11px] tracking-[0.1em] whitespace-nowrap">
                  {new Date(g.timestamp).toLocaleString()}
                </p>
              </li>
            ))}
          </ol>
        </>
      )}
    </main>
  );
}
