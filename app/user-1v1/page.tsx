"use client";

import { Chess } from "chess.js";
import { useEffect, useRef, useState } from "react";

import { Board } from "@/components/Board";
import { EngineConfigPicker } from "@/components/EngineConfigPicker";
import { ResultScreen } from "@/components/ResultScreen";
import { ALL_ENGINE_PRESETS, STOCKFISH_PRESETS, getMoveFor } from "@/lib/chess/engines";
import { describeEnd, type GameEndInfo } from "@/lib/chess/gameLoop";
import type { EngineConfig } from "@/lib/chess/types";
import { saveGame } from "@/lib/games/store";

const START_FEN = new Chess().fen();

type PlayerColor = "white" | "black";

/** Pairs the SAN list into numbered rows: 1. e4 e5 / 2. Nf3 Nc6 / ... */
function toMovePairs(moves: string[]) {
  const pairs: { n: number; white: string; black?: string }[] = [];
  for (let i = 0; i < moves.length; i += 2) {
    pairs.push({ n: i / 2 + 1, white: moves[i], black: moves[i + 1] });
  }
  return pairs;
}

export default function User1v1Page() {
  // Pre-picked so trying the mode is one click. 1320 is the floor preset and
  // the most survivable opponent.
  const [engine, setEngine] = useState<EngineConfig | null>(STOCKFISH_PRESETS[0] ?? null);
  const [userColor, setUserColor] = useState<PlayerColor>("white");

  const [fen, setFen] = useState(START_FEN);
  const [moves, setMoves] = useState<string[]>([]);
  const [started, setStarted] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [end, setEnd] = useState<GameEndInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The Chess instance lives in a ref, NOT in state. Mutating an object held in
  // state doesn't trigger a render and misbehaves under StrictMode's double
  // invocation — the ref is the source of truth, the UI renders from the `fen`
  // string. Same split the Model 1v1 page effectively has.
  const gameRef = useRef<Chess | null>(null);

  // The engine worker is shared and takes ~500ms per reply. Aborting on
  // unmount/restart is what keeps a reply that's still in flight from landing
  // on the next game (or on an unmounted component).
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  function start() {
    if (!engine) return;

    // Cancels any engine reply still in flight from the previous game.
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    const fresh = new Chess();
    gameRef.current = fresh;
    setFen(fresh.fen());
    setMoves([]);
    setEnd(null);
    setError(null);
    setThinking(false);
    setStarted(true);

    // The engine opens when the user takes Black.
    if (userColor === "black") void engineReply();
  }

  function finishGame(game: Chess) {
    const outcome = describeEnd(game);
    setEnd(outcome);

    // saveGame never throws — a failed write (quota, private browsing, KV
    // outage) costs one history entry, not the result screen (Task 9).
    const you = { type: "human" as const, label: "You" };
    const opp = { type: engine!.type, label: engine!.label };
    void saveGame({
      mode: "user-1v1",
      white: userColor === "white" ? you : opp,
      black: userColor === "black" ? you : opp,
      moves: game.history(),
      result: outcome.result,
      endReason: outcome.endReason,
    });
  }

  async function engineReply() {
    const game = gameRef.current;
    const controller = abortRef.current;
    if (!game || !engine) return;

    setThinking(true);
    try {
      const reply = await getMoveFor(game.fen(), engine);

      // A reply we no longer want — the user restarted or left mid-search.
      if (controller?.signal.aborted) return;

      try {
        game.move({ from: reply.from, to: reply.to, promotion: reply.promotion });
      } catch {
        // chess.js 1.x THROWS on an illegal move — it does not return null.
        // chess.js stays authoritative: a bad engine move costs us one random
        // legal move, not the game. Same fallback as gameLoop.ts.
        console.warn(`Illegal move from ${engine.label}:`, reply, "— playing a random legal move");
        const legal = game.moves({ verbose: true });
        const pick = legal[Math.floor(Math.random() * legal.length)];
        game.move({ from: pick.from, to: pick.to, promotion: pick.promotion });
      }

      setFen(game.fen());
      setMoves(game.history());
      if (game.isGameOver()) finishGame(game);
    } catch (err) {
      if (controller?.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      // Skipped after an abort on purpose — a restart has already reset the
      // flag for its own game.
      if (!controller?.signal.aborted) setThinking(false);
    }
  }

  function onPieceDrop(from: string, to: string): boolean {
    const game = gameRef.current;
    if (!game || !started || thinking || end || error) return false;

    const userTurn = (game.turn() === "w") === (userColor === "white");
    if (!userTurn) return false;

    try {
      // Auto-queen on promotion — no under-promotion picker in this MVP.
      game.move({ from, to, promotion: "q" });
    } catch {
      return false; // illegal — the board snaps the piece back
    }

    setFen(game.fen());
    setMoves(game.history());

    if (game.isGameOver()) {
      finishGame(game);
    } else {
      void engineReply();
    }
    return true;
  }

  const inGame = started && !end;
  const engineLabel = engine?.label ?? "—";
  const sideLabel = (color: PlayerColor) => (color === userColor ? "You" : engineLabel);
  const topSide: PlayerColor = userColor === "white" ? "black" : "white";

  return (
    <main className="relative z-1 mx-auto w-full max-w-[1180px] px-8 pt-10 pb-16">
      <h1 className="font-display-black mb-1 text-[clamp(32px,4vw,44px)] leading-tight tracking-[-0.02em] uppercase">
        User 1v1
      </h1>
      <p className="text-er-dim mb-8 text-[17px]">
        Pick your opponent, take a seat at the board. Every move is validated by chess.js.
      </p>

      <div className="flex flex-wrap items-start gap-x-12 gap-y-8">
        {/* Controls + move log */}
        <div className="min-w-[280px] flex-[1_1_320px]">
          <div className="mb-6 flex flex-wrap gap-5">
            <EngineConfigPicker
              presets={ALL_ENGINE_PRESETS}
              value={engine}
              onChange={setEngine}
              label="Opponent"
              disabled={inGame}
            />
            <label className="flex flex-col gap-2">
              <span className="text-er-dim font-mono text-[11px] tracking-[0.2em] uppercase">
                You play
              </span>
              <select
                value={userColor}
                disabled={inGame}
                onChange={(e) => setUserColor(e.target.value as PlayerColor)}
                className="border-er-line bg-er-surface text-er-text focus:border-er-accent cursor-pointer border px-3 py-2 text-[15px] outline-none disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="white">White</option>
                <option value="black">Black</option>
              </select>
            </label>
          </div>

          <button
            onClick={start}
            disabled={!engine}
            className="border-er-accent text-er-accent hover:bg-er-accent hover:text-er-bg mb-6 cursor-pointer border px-6 py-2.5 font-mono text-[12px] tracking-[0.16em] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-er-accent"
          >
            {inGame ? "Restart" : end ? "Play again" : "Start game"}
          </button>

          {inGame && !error && (
            <p className="text-er-dim mb-6 flex items-center gap-2 font-mono text-[11px] tracking-[0.18em] uppercase">
              {thinking ? (
                <>
                  <span className="er-lamp h-2 w-2 rounded-full" />
                  {engineLabel} thinking
                </>
              ) : (
                <>Your move · you play {userColor}</>
              )}
            </p>
          )}

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
            <span>{topSide}</span>
            <span className="text-er-text">{sideLabel(topSide)}</span>
          </div>

          <Board
            fen={fen}
            interactive={inGame && !thinking && !error}
            onPieceDrop={onPieceDrop}
            orientation={userColor}
          />

          <div className="text-er-dim mt-2 flex items-center justify-between font-mono text-[11px] tracking-[0.18em] uppercase">
            <span>{userColor}</span>
            <span className="text-er-text">{sideLabel(userColor)}</span>
          </div>

          {end && (
            <div className="mt-5">
              <ResultScreen
                result={end.result}
                endReason={end.endReason}
                whiteLabel={sideLabel("white")}
                blackLabel={sideLabel("black")}
                onRematch={start}
              />
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
