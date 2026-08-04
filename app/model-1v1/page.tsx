"use client";

import { Chess } from "chess.js";
import { useEffect, useRef, useState } from "react";

import { Board } from "@/components/Board";
import { EngineConfigPicker } from "@/components/EngineConfigPicker";
import { MaiaLoadNotice } from "@/components/MaiaLoadNotice";
import { ResultScreen } from "@/components/ResultScreen";
import { ALL_ENGINE_PRESETS, STOCKFISH_PRESETS } from "@/lib/chess/engines";
import { GameAbortedError, runModelGame, type ModelGameResult } from "@/lib/chess/gameLoop";
import type { EngineConfig } from "@/lib/chess/types";
// Task 8 left this pointing at app/actions/games; Task 9 put an adapter facade
// in front (localStorage today, KV once provisioned), so the import moved.
import { saveGame } from "@/lib/games/store";

const START_FEN = new Chess().fen();

/** Pairs the SAN list into numbered rows: 1. e4 e5 / 2. Nf3 Nc6 / ... */
function toMovePairs(moves: string[]) {
  const pairs: { n: number; white: string; black?: string }[] = [];
  for (let i = 0; i < moves.length; i += 2) {
    pairs.push({ n: i / 2 + 1, white: moves[i], black: moves[i + 1] });
  }
  return pairs;
}

export default function Model1v1Page() {
  // Pre-picked so the demo is one click, and mismatched on purpose — a 1320 vs
  // 2800 game is far more watchable than two equal engines drawing.
  const [white, setWhite] = useState<EngineConfig | null>(STOCKFISH_PRESETS[0] ?? null);
  const [black, setBlack] = useState<EngineConfig | null>(STOCKFISH_PRESETS[2] ?? null);

  const [fen, setFen] = useState(START_FEN);
  const [moves, setMoves] = useState<string[]>([]);
  const [playing, setPlaying] = useState(false);
  const [end, setEnd] = useState<ModelGameResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // Leaving the page mid-game would otherwise leave the loop running and the
  // engine worker busy.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  async function start() {
    if (!white || !black) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setError(null);
    setEnd(null);
    setMoves([]);
    setFen(START_FEN);
    setPlaying(true);

    try {
      const outcome = await runModelGame(
        white,
        black,
        (nextFen, san) => {
          setFen(nextFen);
          setMoves((prev) => [...prev, san]);
        },
        { signal: controller.signal },
      );
      setEnd(outcome);

      // Log the finished game (Task 9). saveGame never throws — a failed write
      // (quota, private browsing, KV outage) costs one history entry, not the
      // result screen the viewer just watched play out.
      await saveGame({
        mode: "model-1v1",
        white: { type: white.type, label: white.label },
        black: { type: black.type, label: black.label },
        moves: outcome.moves,
        result: outcome.result,
        endReason: outcome.endReason,
      });
    } catch (err) {
      // A superseded or unmounted game isn't an error worth showing.
      if (err instanceof GameAbortedError) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      // Only if this run is still the current one — a rematch has already set
      // playing=true for its own game.
      if (!controller.signal.aborted) setPlaying(false);
    }
  }

  const configured = Boolean(white && black);
  const usesMaia = white?.type === "maia" || black?.type === "maia";
  const sideToMove = moves.length % 2 === 0 ? "White" : "Black";
  const thinkingLabel = moves.length % 2 === 0 ? white?.label : black?.label;

  return (
    <main className="relative z-1 mx-auto w-full max-w-[1180px] px-8 pt-10 pb-16">
      <h1 className="font-display-black mb-1 text-[clamp(32px,4vw,44px)] leading-tight tracking-[-0.02em] uppercase">
        Model 1v1
      </h1>
      <p className="text-er-dim mb-8 text-[17px]">
        Pick two engines and watch them run. Every move is validated by chess.js.
      </p>

      <div className="flex flex-wrap items-start gap-x-12 gap-y-8">
        {/* Controls + move log */}
        <div className="min-w-[280px] flex-[1_1_320px]">
          <div className="mb-6 flex flex-wrap gap-5">
            <EngineConfigPicker
              presets={ALL_ENGINE_PRESETS}
              value={white}
              onChange={setWhite}
              label="White"
              disabled={playing}
            />
            <EngineConfigPicker
              presets={ALL_ENGINE_PRESETS}
              value={black}
              onChange={setBlack}
              label="Black"
              disabled={playing}
            />
          </div>

          <button
            onClick={start}
            disabled={playing || !configured}
            className="border-er-accent text-er-accent hover:bg-er-accent hover:text-er-bg mb-6 cursor-pointer border px-6 py-2.5 font-mono text-[12px] tracking-[0.16em] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-er-accent"
          >
            {playing ? "Running…" : end ? "Run it again" : "Start game"}
          </button>

          {playing && (
            <p className="text-er-dim mb-6 flex items-center gap-2 font-mono text-[11px] tracking-[0.18em] uppercase">
              <span className="er-lamp h-2 w-2 rounded-full" />
              {sideToMove} thinking · {thinkingLabel}
            </p>
          )}

          <MaiaLoadNotice active={usesMaia} />

          {error && (
            <div
              role="alert"
              className="border-er-accent text-er-accent mb-6 border px-4 py-3 text-[14px]"
            >
              <strong className="font-semibold">Engine failed.</strong> {error}
              <br />
              Try refreshing the page.
            </div>
          )}

          <div>
            <h2 className="text-er-dim mb-2 font-mono text-[11px] tracking-[0.2em] uppercase">
              Moves · {moves.length} plies
            </h2>
            <div className="border-er-line bg-er-surface2 h-[240px] overflow-y-auto border p-3 font-mono text-[13px]">
              {moves.length === 0 ? (
                <p className="text-er-dim">No moves yet.</p>
              ) : (
                <ol className="grid grid-cols-[auto_1fr_1fr] gap-x-3 gap-y-1">
                  {toMovePairs(moves).map((pair) => (
                    <li key={pair.n} className="col-span-3 grid grid-cols-subgrid">
                      <span className="text-er-dim">{pair.n}.</span>
                      <span>{pair.white}</span>
                      <span>{pair.black ?? ""}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        </div>

        {/* Board */}
        <div className="mx-auto min-w-[300px] flex-[0_1_460px]">
          <div className="text-er-dim mb-2 flex items-center justify-between font-mono text-[11px] tracking-[0.18em] uppercase">
            <span>Black</span>
            <span className="text-er-text">{black?.label ?? "—"}</span>
          </div>

          <Board fen={fen} />

          <div className="text-er-dim mt-2 flex items-center justify-between font-mono text-[11px] tracking-[0.18em] uppercase">
            <span>White</span>
            <span className="text-er-text">{white?.label ?? "—"}</span>
          </div>

          {end && (
            <div className="mt-5">
              <ResultScreen
                result={end.result}
                endReason={end.endReason}
                whiteLabel={white?.label ?? "White"}
                blackLabel={black?.label ?? "Black"}
                onRematch={start}
              />
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
