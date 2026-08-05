"use client";

import { Chess } from "chess.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Board } from "@/components/Board";
import { FxStage, type FxHandle } from "@/components/fx/FxStage";
import { beatDelay, classify, type FxProfile } from "@/lib/fx/classify";
import { ALL_FX_IDS, FX_EFFECTS, FX_GROUP_LABELS, type FxGroup } from "@/lib/fx/effects";
import { freshFxContext, type FxBeat } from "@/lib/fx/types";

/**
 * FX Lab — a disposable picking harness, not a shipped screen.
 *
 * Every effect gets a Fire button that plays it on a real board at a real
 * position, plus a keep checkbox. The bottom of the page prints the kept set so
 * the choice can be handed back as a config rather than described in prose.
 *
 * Lives under app/dev/ with the stockfish and maia test pages — same convention,
 * same expectation that it gets deleted once it's served its purpose.
 */

/* ------------------------------------------------------------------ scenarios */

interface Scenario {
  fen: string;
  /** Played in order. The beat fired is the last one, with context from the rest. */
  moves: { from: string; to: string; promotion?: string }[];
  note: string;
}

const START = new Chess().fen();

const SCENARIOS: Record<string, Scenario> = {
  // Queen takes queen: maximum damage, so the spatter and shake run at full weight.
  bigCapture: {
    fen: "rnbqkbnr/ppp1pppp/8/8/8/8/PPP1PPPP/RNBQKBNR w KQkq - 0 1",
    moves: [{ from: "d1", to: "d8" }],
    note: "Qxd8 — a queen dies, damage 9",
  },
  pawnCapture: {
    fen: "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2",
    moves: [{ from: "e4", to: "d5" }],
    note: "exd5 — a pawn dies, damage 1",
  },
  // Two plies: a capture, then a recapture on the same square.
  counter: {
    fen: "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2",
    moves: [
      { from: "e4", to: "d5" },
      { from: "d8", to: "d5" },
    ],
    note: "exd5 Qxd5 — recapture, combo 2",
  },
  knight: { fen: START, moves: [{ from: "g1", to: "f3" }], note: "Nf3 — the blink" },
  bishop: {
    fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
    moves: [{ from: "f1", to: "c4" }],
    note: "Bc4 — the slash",
  },
  rook: {
    fen: "4k3/8/8/8/8/8/8/R3K3 w - - 0 1",
    moves: [{ from: "a1", to: "a8" }],
    note: "Ra8 — the pile-driver",
  },
  queen: {
    fen: "4k3/8/8/8/8/8/8/3QK3 w - - 0 1",
    moves: [{ from: "d1", to: "h5" }],
    note: "Qh5 — the beam",
  },
  pawn: { fen: START, moves: [{ from: "e2", to: "e4" }], note: "e4 — the jab" },
  king: {
    fen: "4k3/8/8/8/8/8/8/4K3 w - - 0 1",
    moves: [{ from: "e1", to: "e2" }],
    note: "Ke2 — the heavy step",
  },
  check: {
    fen: "4k3/8/8/8/8/8/4Q3/4K3 w - - 0 1",
    moves: [{ from: "e2", to: "e7" }],
    note: "Qe7+ — check",
  },
  mate: {
    fen: "6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1",
    moves: [{ from: "a1", to: "a8" }],
    note: "Ra8# — back-rank mate",
  },
  promotion: {
    fen: "8/P7/4k3/8/8/8/8/4K3 w - - 0 1",
    moves: [{ from: "a7", to: "a8", promotion: "q" }],
    note: "a8=Q — ascension",
  },
  castle: {
    fen: "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1",
    moves: [{ from: "e1", to: "g1" }],
    note: "O-O — the guard closes",
  },
  // Plies 1-4 of the Sicilian, so the opening title card has a name to find.
  opening: {
    fen: START,
    moves: [
      { from: "e2", to: "e4" },
      { from: "c7", to: "c5" },
    ],
    note: "1.e4 c5 — SICILIAN DEFENCE",
  },
};

/** Which scenario each effect's Fire button plays. */
const EFFECT_SCENARIO: Record<string, string> = {
  impact: "bigCapture",
  lines: "bigCapture",
  blot: "bigCapture",
  drops: "bigCapture",
  shake: "bigCapture",
  damage: "bigCapture",
  streak: "bishop",
  ghosts: "bishop",
  signature: "knight",
  vignette: "check",
  alarm: "check",
  callout: "opening",
  pillar: "promotion",
  cinema: "mate",
  crack: "mate",
  combo: "counter",
};

/** Extra Fire buttons for effects with meaningfully different variants. */
const VARIANTS: Record<string, { label: string; scenario: string }[]> = {
  signature: [
    { label: "Pawn", scenario: "pawn" },
    { label: "Knight", scenario: "knight" },
    { label: "Bishop", scenario: "bishop" },
    { label: "Rook", scenario: "rook" },
    { label: "Queen", scenario: "queen" },
    { label: "King", scenario: "king" },
  ],
  callout: [
    { label: "Opening", scenario: "opening" },
    { label: "Danger", scenario: "check" },
    { label: "Counter", scenario: "counter" },
    { label: "Ascension", scenario: "promotion" },
    { label: "Checkmate", scenario: "mate" },
  ],
  drops: [
    { label: "Pawn hit", scenario: "pawnCapture" },
    { label: "Queen hit", scenario: "bigCapture" },
  ],
  shake: [
    { label: "Pawn hit", scenario: "pawnCapture" },
    { label: "Queen hit", scenario: "bigCapture" },
  ],
};

const OPERA_GAME = [
  "e4", "e5", "Nf3", "d6", "d4", "Bg4", "dxe5", "Bxf3", "Qxf3", "dxe5",
  "Bc4", "Nf6", "Qb3", "Qe7", "Nc3", "c6", "Bg5", "b5", "Nxb5", "cxb5",
  "Bxb5+", "Nbd7", "O-O-O", "Rd8", "Rxd7", "Rxd7", "Rd1", "Qe6", "Bxd7+",
  "Nxd7", "Qb8+", "Nxb8", "Rd8#",
];

/** Board render + our own fire delay, so the piece has landed before it's hit. */
const SETTLE_MS = 90;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------------------------------------------ component */

export default function FxLabPage() {
  const fx = useRef<FxHandle>(null);
  const runRef = useRef(0);

  const [fen, setFen] = useState(START);
  const [kept, setKept] = useState<Set<string>>(new Set(ALL_FX_IDS));
  const [profile, setProfile] = useState<FxProfile>("spectate");
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [charging, setCharging] = useState(false);
  const [showHp, setShowHp] = useState(false);

  // Abandon any in-flight run when the page goes away.
  useEffect(() => {
    return () => {
      runRef.current += 1;
    };
  }, []);

  const say = useCallback((line: string) => {
    setLog((prev) => [line, ...prev].slice(0, 14));
  }, []);

  const toggle = (id: string) =>
    setKept((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /**
   * Plays a scenario's moves, then fires. `only` fires exactly one effect
   * (a row's Fire button); omitting it runs the full tier-gated set.
   */
  const play = useCallback(
    async (scenarioKey: string, only?: string) => {
      const scenario = SCENARIOS[scenarioKey];
      if (!scenario) return;

      const token = ++runRef.current;
      fx.current?.clear();

      const chess = new Chess(scenario.fen);
      setFen(chess.fen());
      const ctx = freshFxContext();

      // Let the board paint the starting position before the first move lands.
      await sleep(SETTLE_MS);
      if (runRef.current !== token) return;

      for (let i = 0; i < scenario.moves.length; i++) {
        const spec = scenario.moves[i];
        let beat: FxBeat;

        try {
          const move = chess.move(spec);
          beat = classify(
            {
              move: {
                from: move.from,
                to: move.to,
                piece: move.piece,
                color: move.color,
                captured: move.captured,
                promotion: move.promotion,
                san: move.san,
                flags: move.flags,
              },
              isCheck: chess.isCheck(),
              isCheckmate: chess.isCheckmate(),
              sanHistory: chess.history(),
              mine: profile === "play" && move.color === "w",
            },
            ctx,
            profile,
          );
        } catch (err) {
          say(`REJECTED ${spec.from}${spec.to} in "${scenarioKey}" — ${String(err)}`);
          return;
        }

        setFen(chess.fen());
        await sleep(SETTLE_MS);
        if (runRef.current !== token) return;

        const last = i === scenario.moves.length - 1;
        if (last && only) {
          fx.current?.fireOne(only, beat);
          say(`${only} · ${beat.callout ?? beat.kind} · tier ${beat.tier}`);
        } else if (last) {
          fx.current?.fire(beat, kept);
          say(`full beat · ${beat.kind} · tier ${beat.tier} · ${beatDelay(beat)}ms hold`);
        } else {
          // Intermediate plies still need to render so recapture/combo read right.
          fx.current?.fire(beat, kept);
          await sleep(beatDelay(beat));
          if (runRef.current !== token) return;
        }
      }
    },
    [kept, profile, say],
  );

  /** The full-game run: real classification, real tier timing, kept effects only. */
  const runGame = useCallback(async () => {
    const token = ++runRef.current;
    setRunning(true);
    fx.current?.clear();
    fx.current?.hp(null);

    const chess = new Chess();
    setFen(chess.fen());
    const ctx = freshFxContext();

    if (kept.has("vs")) {
      fx.current?.vs({
        whiteLabel: "Stockfish 2800",
        blackLabel: "Stockfish 1320",
        whiteElo: "ELO 2800",
        blackElo: "ELO 1320",
      });
      await sleep(1700);
      fx.current?.vs(null);
    }
    if (runRef.current !== token) return setRunning(false);

    for (const san of OPERA_GAME) {
      if (runRef.current !== token) return setRunning(false);

      let beat: FxBeat;
      try {
        const move = chess.move(san);
        beat = classify(
          {
            move: {
              from: move.from,
              to: move.to,
              piece: move.piece,
              color: move.color,
              captured: move.captured,
              promotion: move.promotion,
              san: move.san,
              flags: move.flags,
            },
            isCheck: chess.isCheck(),
            isCheckmate: chess.isCheckmate(),
            sanHistory: chess.history(),
            mine: profile === "play" && move.color === "w",
          },
          ctx,
          profile,
        );
      } catch (err) {
        say(`REJECTED ${san} — ${String(err)}`);
        setRunning(false);
        return;
      }

      setFen(chess.fen());
      await sleep(SETTLE_MS);
      if (runRef.current !== token) return setRunning(false);

      fx.current?.fire(beat, kept);
      if (beat.tier > 0) say(`${san} · ${beat.kind} · tier ${beat.tier}`);

      if (kept.has("hp")) {
        const mat = material(chess);
        fx.current?.hp({ white: mat.white, black: mat.black, hit: beat.victim ? beat.color === "w" ? "b" : "w" : null });
      }

      await sleep(Math.max(0, beatDelay(beat) - SETTLE_MS));
    }

    say("game over — Rd8#");
    setRunning(false);
  }, [kept, profile, say]);

  const stop = useCallback(() => {
    runRef.current += 1;
    setRunning(false);
    fx.current?.clear();
    fx.current?.vs(null);
    fx.current?.charge(null);
    setCharging(false);
  }, []);

  /* Ki charge runs on its own clock — in the real app this is fed Stockfish's
     streamed `info depth` instead of a ramp. */
  useEffect(() => {
    if (!charging) {
      fx.current?.charge(null);
      return;
    }
    let pct = 0;
    const t = window.setInterval(() => {
      pct = pct >= 100 ? 0 : Math.min(100, pct + 4);
      fx.current?.charge({ side: "w", pct });
    }, 90);
    return () => clearInterval(t);
  }, [charging]);

  useEffect(() => {
    if (showHp) fx.current?.hp({ white: 100, black: 100, hit: null });
    else fx.current?.hp(null);
  }, [showHp]);

  const grouped = useMemo(() => {
    const out = new Map<FxGroup, typeof FX_EFFECTS>();
    for (const e of FX_EFFECTS) {
      const list = out.get(e.group) ?? [];
      list.push(e);
      out.set(e.group, list);
    }
    return out;
  }, []);

  const keptList = FX_EFFECTS.filter((e) => kept.has(e.id)).map((e) => e.id);

  return (
    <main className="relative z-1 mx-auto w-full max-w-[1240px] px-8 pt-10 pb-20">
      <h1 className="font-display-black mb-1 text-[clamp(30px,4vw,42px)] leading-tight tracking-[-0.02em] uppercase">
        FX Lab
      </h1>
      <p className="text-er-dim mb-8 max-w-[70ch] text-[16px]">
        Every effect fires on a real board at a real position. Tick what you want to keep — the
        chosen set prints at the bottom. Nothing here is wired into the game screens yet.
      </p>

      <div className="flex flex-wrap items-start gap-x-12 gap-y-10">
        {/* ------------------------------------------------------------ board */}
        <div className="sticky top-6 mx-auto min-w-[320px] flex-[0_1_500px] self-start">
          <div className="text-er-dim mb-8 flex items-center justify-between font-mono text-[11px] tracking-[0.18em] uppercase">
            <span>Stage</span>
            <span className="text-er-text">{profile === "spectate" ? "Model 1v1" : "User 1v1"}</span>
          </div>

          <FxStage ref={fx}>
            <Board fen={fen} />
          </FxStage>

          <div className="mt-9 flex flex-wrap gap-2">
            <button onClick={runGame} disabled={running} className={btn}>
              {running ? "Running…" : "Run a full game"}
            </button>
            <button onClick={stop} className={btnGhost}>
              Stop / clear
            </button>
            <button onClick={() => setCharging((c) => !c)} className={btnGhost}>
              {charging ? "Charge off" : "Ki charge"}
            </button>
            <button onClick={() => setShowHp((h) => !h)} className={btnGhost}>
              {showHp ? "HP off" : "HP bars"}
            </button>
            <button
              onClick={() => {
                fx.current?.vs({
                  whiteLabel: "Stockfish 2800",
                  blackLabel: "Maia 1500",
                  whiteElo: "ELO 2800",
                  blackElo: "Tier 1500",
                });
                // The card wipes itself out; unmount it after so a re-fire replays.
                window.setTimeout(() => fx.current?.vs(null), 1800);
              }}
              className={btnGhost}
            >
              VS card
            </button>
          </div>

          <div className="mt-5">
            <div className="text-er-dim mb-2 font-mono text-[10px] tracking-[0.2em] uppercase">
              Profile
            </div>
            <div className="flex gap-2">
              {(["spectate", "play"] as FxProfile[]).map((p) => (
                <button
                  key={p}
                  onClick={() => setProfile(p)}
                  className={p === profile ? btn : btnGhost}
                >
                  {p === "spectate" ? "Spectate · full" : "Play · muted engine"}
                </button>
              ))}
            </div>
          </div>

          <div className="border-er-line bg-er-surface2 mt-5 h-[150px] overflow-y-auto border p-3 font-mono text-[11px]">
            {log.length === 0 ? (
              <p className="text-er-dim">Fire something.</p>
            ) : (
              log.map((l, i) => (
                <div key={i} className={i === 0 ? "text-er-text" : "text-er-dim"}>
                  {l}
                </div>
              ))
            )}
          </div>
        </div>

        {/* ---------------------------------------------------------- effects */}
        <div className="min-w-[320px] flex-[1_1_460px]">
          {[...grouped.entries()].map(([group, effects]) => (
            <section key={group} className="mb-8">
              <h2 className="text-er-accent border-er-line mb-3 border-b pb-2 font-mono text-[11px] tracking-[0.22em] uppercase">
                {FX_GROUP_LABELS[group]}
              </h2>

              {effects.map((e) => {
                const variants = VARIANTS[e.id];
                const scenario = EFFECT_SCENARIO[e.id];
                return (
                  <div key={e.id} className="border-er-line border-b py-3">
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={kept.has(e.id)}
                        onChange={() => toggle(e.id)}
                        aria-label={`Keep ${e.label}`}
                        className="accent-er-accent mt-1 h-4 w-4 shrink-0 cursor-pointer"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                          <span className="text-[15px] font-semibold">{e.label}</span>
                          <span className="text-er-dim font-mono text-[10px] tracking-[0.16em] uppercase">
                            {e.device}
                          </span>
                          <span className="text-er-dim font-mono text-[10px] tracking-[0.16em] uppercase">
                            {e.tier === 9 ? "manual" : `tier ${e.tier}+`}
                          </span>
                        </div>
                        <p className="text-er-dim mt-0.5 text-[13px] leading-snug">{e.blurb}</p>

                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {variants
                            ? variants.map((v) => (
                                <button
                                  key={v.label}
                                  onClick={() => play(v.scenario, e.id)}
                                  className={btnTiny}
                                >
                                  {v.label}
                                </button>
                              ))
                            : scenario && (
                                <button onClick={() => play(scenario, e.id)} className={btnTiny}>
                                  Fire
                                </button>
                              )}
                          {scenario && (
                            <span className="text-er-dim self-center font-mono text-[10px]">
                              {SCENARIOS[scenario]?.note}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </section>
          ))}

          {/* --------------------------------------------------- whole beats */}
          <section className="mb-8">
            <h2 className="text-er-accent border-er-line mb-3 border-b pb-2 font-mono text-[11px] tracking-[0.22em] uppercase">
              Whole beats · everything ticked, at once
            </h2>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(SCENARIOS).map(([key, s]) => (
                <button key={key} onClick={() => play(key)} className={btnTiny} title={s.note}>
                  {key}
                </button>
              ))}
            </div>
            <p className="text-er-dim mt-2 text-[13px]">
              These run the real tier gate, so a scenario only shows the effects its tier earns.
            </p>
          </section>

          {/* -------------------------------------------------------- output */}
          <section>
            <h2 className="text-er-accent border-er-line mb-3 border-b pb-2 font-mono text-[11px] tracking-[0.22em] uppercase">
              Your set · {keptList.length}/{FX_EFFECTS.length}
            </h2>
            <div className="flex gap-2 pb-3">
              <button onClick={() => setKept(new Set(ALL_FX_IDS))} className={btnGhost}>
                All
              </button>
              <button onClick={() => setKept(new Set())} className={btnGhost}>
                None
              </button>
            </div>
            <pre className="border-er-line bg-er-surface2 overflow-x-auto border p-3 font-mono text-[12px] whitespace-pre-wrap">
              {JSON.stringify({ profile, keep: keptList }, null, 2)}
            </pre>
          </section>
        </div>
      </div>
    </main>
  );
}

/** Material as a 0-100 rail, 39 pawns of non-king material being full health. */
function material(chess: Chess) {
  const value: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  let w = 0;
  let b = 0;
  for (const row of chess.board()) {
    for (const sq of row) {
      if (!sq) continue;
      const v = value[sq.type] ?? 0;
      if (sq.color === "w") w += v;
      else b += v;
    }
  }
  return { white: Math.round((w / 39) * 100), black: Math.round((b / 39) * 100) };
}

const btn =
  "border-er-accent text-er-accent hover:bg-er-accent hover:text-er-bg cursor-pointer border px-4 py-2 font-mono text-[11px] tracking-[0.16em] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-40";

const btnGhost =
  "border-er-line text-er-dim hover:border-er-text hover:text-er-text cursor-pointer border px-4 py-2 font-mono text-[11px] tracking-[0.16em] uppercase transition-colors";

const btnTiny =
  "border-er-line text-er-text hover:border-er-accent hover:text-er-accent cursor-pointer border px-2.5 py-1 font-mono text-[10px] tracking-[0.14em] uppercase transition-colors";
