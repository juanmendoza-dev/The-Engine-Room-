"use client";

import { Chess } from "chess.js";
import { useEffect, useRef, useState } from "react";

import { Board } from "@/components/Board";
import { EngineConfigPicker } from "@/components/EngineConfigPicker";
import { FxStage, type FxHandle } from "@/components/fx/FxStage";
import { MaiaLoadNotice } from "@/components/MaiaLoadNotice";
import { ResultScreen } from "@/components/ResultScreen";
import { publishBoardFrame } from "@/lib/boardFeed";
import { ALL_ENGINE_PRESETS, STOCKFISH_PRESETS, usesMaiaWeights } from "@/lib/chess/engines";
import { GameAbortedError, runModelGame, type ModelGameResult } from "@/lib/chess/gameLoop";
import type { EngineConfig } from "@/lib/chess/types";
import { beatDelay, classify } from "@/lib/fx/classify";
import { ALL_FX_IDS } from "@/lib/fx/effects";
import { depthToPct, INDETERMINATE_CHARGE_PCT, materialHp, useFxEnabled } from "@/lib/fx/runtime";
import { freshFxContext } from "@/lib/fx/types";
// Task 8 left this pointing at app/actions/games; Task 9 put an adapter facade
// in front (localStorage today, KV once provisioned), so the import moved.
import { saveGame } from "@/lib/games/store";

const START_FEN = new Chess().fen();

/** How long the VS card holds before the first search starts. */
const VS_CARD_MS = 1700;

/**
 * Must match `animationDurationInMs` in components/Board.tsx. The effect for a
 * ply fires after the piece has finished sliding — hitting a square the piece
 * hasn't reached yet reads as the effect missing.
 */
const BOARD_SLIDE_MS = 220;

/** Every effect is on here — Model 1v1 is a spectator sport, so full ceiling. */
const FX_SET = new Set(ALL_FX_IDS);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** "ELO 2800" / "Tier 1500" / "β 1 · T 0" — the VS card's power-level line. */
function eloLabel(config: EngineConfig): string {
  // Before the elo/tier checks: a mixture config carries a `ratingTier` for its
  // internal Maia call, and showing that as "Tier 1500" would read as a strength
  // claim the engine has no basis for. Its α/β/T are the honest description.
  if (config.type === "mixture") {
    return `β ${config.beta ?? 1} · T ${config.temperature ?? 0}`;
  }
  if (config.elo) return `ELO ${config.elo}`;
  if (config.ratingTier) return `Tier ${config.ratingTier}`;
  return config.type;
}

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

  // Fight FX. The stage handle is imperative on purpose: effects are fire-and-
  // forget animations, not state, and routing them through React state would
  // re-render the board mid-game for something the board doesn't care about.
  const fx = useRef<FxHandle>(null);
  const fxOn = useFxEnabled();
  // Recapture and combo detection span plies, so the classifier needs somewhere
  // to keep score across a whole game. Reset per game in start().
  const fxCtx = useRef(freshFxContext());

  // Leaving the page mid-game would otherwise leave the loop running and the
  // engine worker busy.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // Drive the header's scoreboard. The board below is always on screen (it shows
  // the start position before you hit Start), so this publishes from ply 0 —
  // unlike /user-1v1, where there's genuinely no board until a game begins.
  useEffect(() => {
    publishBoardFrame({
      ply: moves.length,
      lastSan: moves.at(-1) ?? null,
      over: Boolean(end),
    });
  }, [moves, end]);

  useEffect(() => {
    return () => publishBoardFrame(null);
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

    // Clear anything still animating from the previous game before resetting the
    // cross-ply tallies, or a rematch inherits the last game's combo count.
    fx.current?.clear();
    fxCtx.current = freshFxContext();

    if (fxOn) {
      fx.current?.hp({ white: 100, black: 100, hit: null });
      fx.current?.vs({
        whiteLabel: white.label,
        blackLabel: black.label,
        whiteElo: eloLabel(white),
        blackElo: eloLabel(black),
      });
      await sleep(VS_CARD_MS);
      // A rematch or a navigation during the card should not then start a game.
      if (controller.signal.aborted) return;
      fx.current?.vs(null);
    }

    try {
      const outcome = await runModelGame(
        white,
        black,
        (nextFen, san, played) => {
          setFen(nextFen);
          setMoves((prev) => [...prev, san]);

          if (!fxOn) return;

          // The engine has answered, so the charge is spent.
          fx.current?.charge(null);

          const beat = classify(
            {
              move: played.move,
              isCheck: played.isCheck,
              isCheckmate: played.isCheckmate,
              sanHistory: played.history,
            },
            fxCtx.current,
            "spectate",
          );

          // The board takes ~220ms to slide the piece (Board's own
          // animationDurationInMs). Firing on the same tick would land the hit
          // before the piece arrives, so the effect waits for the landing.
          const hp = materialHp(new Chess(played.fen));
          window.setTimeout(() => {
            if (controller.signal.aborted) return;
            fx.current?.fire(beat, FX_SET);
            fx.current?.hp({
              ...hp,
              hit: beat.victim ? (beat.color === "w" ? "b" : "w") : null,
            });
          }, BOARD_SLIDE_MS);

          // The hit-stop. Tier decides how long the game holds on this ply, plus
          // the slide we just waited out so the pause is *after* the effect.
          return beatDelay(beat) + BOARD_SLIDE_MS;
        },
        {
          signal: controller.signal,
          onThinkStart: (side, engine) => {
            if (!fxOn) return;
            // Maia has no search, so nothing will report depth — show an
            // indeterminate charge rather than a bar stuck at zero.
            //
            // `type === "maia"` and NOT usesMaiaWeights() — deliberately the
            // opposite of the MaiaLoadNotice check below. A mixture config runs a
            // real Stockfish search that streams `info depth` through onInfo, so it
            // wants the real bar, not the indeterminate one.
            fx.current?.charge({
              side,
              pct: engine.type === "maia" ? INDETERMINATE_CHARGE_PCT : 0,
            });
          },
          onSearchDepth: (side, depth) => {
            if (!fxOn) return;
            fx.current?.charge({ side, pct: depthToPct(depth) });
          },
        },
      );
      setEnd(outcome);
      fx.current?.charge(null);

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
      fx.current?.charge(null);
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
  // usesMaiaWeights, not `type === "maia"`: a mixture config pays the same ~93MB
  // download for its internal Maia call, so the notice has to cover it too.
  const usesMaia = Boolean(
    (white && usesMaiaWeights(white)) || (black && usesMaiaWeights(black)),
  );
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

          {/* The HP rails sit just outside the board, so the stage needs vertical
              room for them — mt/mb rather than padding, which would stretch the
              stage box the effects measure against. */}
          <div className="my-8">
            <FxStage ref={fx} disabled={!fxOn}>
              <Board fen={fen} />
            </FxStage>
          </div>

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
