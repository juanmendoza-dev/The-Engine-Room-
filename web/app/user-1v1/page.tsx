"use client";

import { Chess } from "chess.js";
import { useEffect, useRef, useState } from "react";

import { Board } from "@/components/Board";
import { EngineConfigPicker } from "@/components/EngineConfigPicker";
import { FxStage, type FxHandle } from "@/components/fx/FxStage";
import { MaiaLoadNotice } from "@/components/MaiaLoadNotice";
import { RatingReadout } from "@/components/RatingReadout";
import { ResultScreen } from "@/components/ResultScreen";
import {
  createRatingEstimator,
  resolveOppoBucket,
  summarizePosterior,
  updateRatingEstimator,
  type RatingEstimatorState,
  type RatingReport,
} from "@/lib/analysis/ratingPosterior";
import { publishBoardFrame } from "@/lib/boardFeed";
import {
  ALL_ENGINE_PRESETS,
  STOCKFISH_PRESETS,
  getMoveFor,
  parseSearchDepth,
} from "@/lib/chess/engines";
import { describeEnd, type GameEndInfo } from "@/lib/chess/gameLoop";
import type { EngineConfig } from "@/lib/chess/types";
import { classify } from "@/lib/fx/classify";
import { ALL_FX_IDS } from "@/lib/fx/effects";
import { depthToPct, INDETERMINATE_CHARGE_PCT, materialHp, useFxEnabled } from "@/lib/fx/runtime";
import { freshFxContext } from "@/lib/fx/types";
import { saveGame } from "@/lib/games/store";

const START_FEN = new Chess().fen();

type PlayerColor = "white" | "black";

/** Must match `animationDurationInMs` in components/Board.tsx. */
const BOARD_SLIDE_MS = 220;

/**
 * Every effect is on here too, but the "play" profile mutes the engine's own
 * beats (see classify()) so the board you're playing on never gets buried while
 * it's your turn to read it. There's no hit-stop on this screen: the pause in
 * Model 1v1 is between two engines nobody is waiting on, whereas here it would be
 * lag between your drag and the reply.
 */
const FX_SET = new Set(ALL_FX_IDS);

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

  // Fight FX. Imperative handle, and a per-game classifier context for the
  // cross-ply tallies (recapture, combo, opening announcements).
  const fx = useRef<FxHandle>(null);
  const fxOn = useFxEnabled();
  const fxCtx = useRef(freshFxContext());

  // Rating estimator. Same split as the Chess instance: the accumulating state
  // lives in a ref and the UI renders off a derived report in state.
  const [ratingReport, setRatingReport] = useState<RatingReport | null>(null);
  const [ratingWorking, setRatingWorking] = useState(false);
  const estimatorRef = useRef<RatingEstimatorState | null>(null);
  // Each update reads the current state and returns a successor, so two
  // overlapping updates would both start from the same base and one would
  // silently drop the other's evidence. One chain, strictly in ply order.
  const estimatorQueue = useRef<Promise<void>>(Promise.resolve());
  const estimatorPending = useRef(0);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // Drive the header's scoreboard. Gated on `started` because this page shows no
  // board until you begin — a "move 0" readout above an empty column would be
  // describing a game that isn't set up yet.
  useEffect(() => {
    publishBoardFrame(
      started ? { ply: moves.length, lastSan: moves.at(-1) ?? null, over: Boolean(end) } : null,
    );
  }, [started, moves, end]);

  useEffect(() => {
    return () => publishBoardFrame(null);
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

    // Restart is allowed mid-game here, so this has to clear whatever is still
    // animating as well as reset the cross-ply tallies.
    fx.current?.clear();
    fx.current?.charge(null);
    fxCtx.current = freshFxContext();
    if (fxOn) fx.current?.hp({ white: 100, black: 100, hit: null });

    // elo_oppo is resolved once, here, and pinned for the whole game — it's the
    // opponent actually sitting there, not a hypothesis being swept.
    estimatorRef.current = createRatingEstimator(resolveOppoBucket(engine));
    estimatorPending.current = 0;
    setRatingReport(null);
    setRatingWorking(false);

    // The engine opens when the user takes Black.
    if (userColor === "black") void engineReply();
  }

  /**
   * Fire the beat for a ply that just landed. `mine` is what earns the human's
   * moves full weight under the "play" profile — your captures should hit harder
   * than the engine's, since you're the one who made them.
   */
  function runFx(game: Chess, mine: boolean) {
    if (!fxOn) return;

    const played = game.history({ verbose: true }).at(-1);
    if (!played) return;

    const beat = classify(
      {
        move: played,
        isCheck: game.isCheck(),
        isCheckmate: game.isCheckmate(),
        sanHistory: game.history(),
        mine,
      },
      fxCtx.current,
      "play",
    );

    const hp = materialHp(game);
    // Wait out the board's own piece slide — an effect on a square the piece
    // hasn't arrived at yet just looks like it missed.
    window.setTimeout(() => {
      fx.current?.fire(beat, FX_SET);
      fx.current?.hp({ ...hp, hit: beat.victim ? (beat.color === "w" ? "b" : "w") : null });
    }, BOARD_SLIDE_MS);
  }

  /**
   * Folds the player's last move into the posterior. Fire-and-forget on purpose:
   * this is up to nine Maia forward passes, ~400ms, and it must never sit between
   * the drag and the reply. Nothing awaits it and nothing on the game path reads
   * its result.
   *
   * A failure here costs the readout one ply and nothing else — the board, the
   * opponent and the result screen don't know this exists.
   */
  function scoreLastMove(game: Chess) {
    const played = game.history({ verbose: true }).at(-1);
    if (!played) return;

    // `before` is the position the move was chosen in and `lan` is its
    // from+to+promotion form — both straight off chess.js, no snapshotting.
    const { before, lan } = played;
    const controller = abortRef.current;

    estimatorPending.current += 1;
    setRatingWorking(true);
    estimatorQueue.current = estimatorQueue.current.then(async () => {
      try {
        const base = estimatorRef.current;
        if (!base || controller?.signal.aborted) return;

        const next = await updateRatingEstimator(base, before, lan);

        // The user restarted or left while those passes were running.
        if (controller?.signal.aborted || estimatorRef.current !== base) return;
        estimatorRef.current = next;
        setRatingReport(summarizePosterior(next));
      } catch (err) {
        console.warn("Rating estimate skipped for one move:", err);
      } finally {
        estimatorPending.current -= 1;
        if (estimatorPending.current === 0) setRatingWorking(false);
      }
    });
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
    if (fxOn) {
      // Maia reports no depth (no search), so show an indeterminate charge rather
      // than a bar pinned at zero for the whole reply.
      fx.current?.charge({
        side: userColor === "white" ? "b" : "w",
        pct: engine.type === "maia" ? INDETERMINATE_CHARGE_PCT : 0,
      });
    }

    try {
      const reply = await getMoveFor(game.fen(), engine, (line) => {
        if (!fxOn || controller?.signal.aborted) return;
        const depth = parseSearchDepth(line);
        if (depth !== null) {
          fx.current?.charge({ side: userColor === "white" ? "b" : "w", pct: depthToPct(depth) });
        }
      });

      // A reply we no longer want — the user restarted or left mid-search.
      if (controller?.signal.aborted) return;
      fx.current?.charge(null);

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
      runFx(game, false);
      if (game.isGameOver()) finishGame(game);
    } catch (err) {
      fx.current?.charge(null);
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
    runFx(game, true);

    if (game.isGameOver()) {
      finishGame(game);
    } else {
      void engineReply();
    }

    // After engineReply, deliberately. Against a Maia opponent both share one
    // ORT session and the queue in engineMaia.ts is FIFO, so starting the reply
    // first keeps its single forward pass ahead of our nine rather than behind
    // ~400ms of them. The last move of a finished game still gets scored — it's
    // evidence like any other.
    scoreLastMove(game);
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

          <MaiaLoadNotice active={engine?.type === "maia"} />

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

          {/* Only once a game exists. Before that there are no moves to read,
              and a "reading your moves…" line over an empty board would be
              describing something that isn't happening. Stays up after the game
              ends, where the read is at its most informative. */}
          {started && <RatingReadout report={ratingReport} working={ratingWorking} />}
        </div>

        {/* Board */}
        <div className="mx-auto min-w-[300px] flex-[0_1_460px]">
          <div className="text-er-dim mb-2 flex items-center justify-between font-mono text-[11px] tracking-[0.18em] uppercase">
            <span>{topSide}</span>
            <span className="text-er-text">{sideLabel(topSide)}</span>
          </div>

          {/* FxStage's overlay is pointer-events: none, which is what keeps the
              effects from eating the drags this board depends on — react-chessboard
              v5 drives them through dnd-kit's PointerSensor. */}
          <div className="my-8">
            <FxStage ref={fx} disabled={!fxOn} orientation={userColor}>
              <Board
                fen={fen}
                interactive={inGame && !thinking && !error}
                onPieceDrop={onPieceDrop}
                orientation={userColor}
              />
            </FxStage>
          </div>

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
