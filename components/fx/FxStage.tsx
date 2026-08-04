"use client";

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";

import type { FxBeat } from "@/lib/fx/types";

import "./fx.css";

/**
 * FxStage — wraps a board and renders fight effects over it.
 *
 * Two hard rules this component exists to enforce:
 *
 * 1. **The overlay never takes pointer events.** User 1v1's drags run through
 *    dnd-kit's PointerSensor; an overlay that captures pointers breaks the board
 *    silently. `pointer-events: none` lives in fx.css and must stay.
 * 2. **Geometry is measured in one pass, at one scroll position.** Every effect's
 *    coordinates come from a single `measure()` call that reads all the squares it
 *    needs before anything animates, and nothing here ever calls
 *    `scrollIntoView`. That's the trap documented in docs/deployment.md §4 —
 *    measuring `from` and `to` at different scroll offsets puts effects ~48px off
 *    once the page is tall enough to scroll, which looks like a broken feature.
 *
 * Effects are throwaway DOM: each one is pushed with a TTL and removed when its
 * animation ends, so a 60-ply game doesn't leave 400 dead nodes in the tree.
 */

/* ------------------------------------------------------------------ geometry */

interface SquareGeom {
  x: number;
  y: number;
  size: number;
}

/**
 * All requested squares' centres, from one layout read.
 *
 * `root` must be the *stage*, not the overlay — the board is a sibling of the
 * overlay, so querying `[data-square]` from the overlay finds nothing and every
 * effect silently no-ops. Coordinates come back relative to the stage's own box,
 * which is what the overlay wants since it's `inset: 0` on the stage.
 *
 * Returns nulls for squares that aren't rendered (the board may be mid-mount).
 */
function measure(root: HTMLElement, squares: string[]): (SquareGeom | null)[] {
  const box = root.getBoundingClientRect();
  return squares.map((sq) => {
    const el = root.querySelector<HTMLElement>(`[data-square="${sq}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: r.left - box.left + r.width / 2,
      y: r.top - box.top + r.height / 2,
      size: r.width,
    };
  });
}

/** The piece art currently sitting on a square, for afterimage clones. */
function pieceArt(root: HTMLElement, square: string): string | null {
  const el = root.querySelector<HTMLElement>(`[data-square="${square}"]`);
  const html = el?.innerHTML.trim();
  return html ? html : null;
}

/* --------------------------------------------------------------- node shapes */

type Drop = { dx: string; dy: string; size: string; dur: string; delay: string; rot: string };
type Spark = { dx: string; rise: string; len: string; dur: string; delay: string };
type CrackPath = { d: string; len: number; delay: number };

/**
 * One effect's payload. Kept separate from the id rather than written as
 * `Omit<FxNode, "id">` — Omit over a union collapses it to the keys the members
 * share, which here is just `k`, so every emitter would fail to typecheck.
 */
type FxNodeSpec =
  | { k: "impact" }
  | { k: "lines"; g: SquareGeom; rot: number }
  | { k: "blot"; g: SquareGeom }
  | { k: "drops"; g: SquareGeom; drops: Drop[] }
  | { k: "streak"; g: SquareGeom; len: number; angle: number; thick: number; variant: string }
  | { k: "ghost"; g: SquareGeom; art: string; delay: number }
  | { k: "ring"; g: SquareGeom; delay: number; ink: boolean }
  | { k: "slamBar"; g: SquareGeom; angle: number }
  | { k: "vignette" }
  | { k: "alarm"; g: SquareGeom }
  | { k: "callout"; text: string; kicker?: string; hold: number; ink: boolean; muted: boolean }
  | { k: "damage"; g: SquareGeom; text: string }
  | { k: "combo"; n: number }
  | { k: "pillar"; g: SquareGeom }
  | { k: "sparks"; g: SquareGeom; sparks: Spark[] }
  | { k: "crack"; paths: CrackPath[] };

type FxNode = FxNodeSpec & { id: number };

export interface FxChargeState {
  /** Which side is searching — its half of the board lights up. */
  side: "w" | "b";
  /** Search depth as a 0-100 rail. Fed real `info depth` in the app. */
  pct: number;
  label?: string;
}

export interface FxVsState {
  whiteLabel: string;
  blackLabel: string;
  whiteElo?: string;
  blackElo?: string;
}

export interface FxHpState {
  /** 0-100 each, material-derived. */
  white: number;
  black: number;
  /** Which side just took damage, for the red flash. */
  hit?: "w" | "b" | null;
}

export interface FxHandle {
  /** Emit everything `beat` calls for, filtered by the enabled set. */
  fire: (beat: FxBeat, enabled: Set<string> | string[]) => void;
  /** Emit exactly one effect regardless of tier gating. The lab's Fire buttons. */
  fireOne: (effectId: string, beat: FxBeat) => void;
  charge: (state: FxChargeState | null) => void;
  vs: (state: FxVsState | null) => void;
  hp: (state: FxHpState | null) => void;
  /** Clear every live effect immediately (restart, unmount, navigating away). */
  clear: () => void;
}

interface FxStageProps {
  children: ReactNode;
  ref?: Ref<FxHandle>;
  /** Master off switch — reduced motion, or `?fx=off` for the CDP harnesses. */
  disabled?: boolean;
}

/* ------------------------------------------------------------------ generators */

function makeDrops(count: number, spread: number): Drop[] {
  return Array.from({ length: count }, () => {
    const angle = Math.random() * Math.PI * 2;
    const dist = spread * (0.35 + Math.random() * 0.85);
    return {
      dx: `${(Math.cos(angle) * dist).toFixed(1)}px`,
      dy: `${(Math.sin(angle) * dist).toFixed(1)}px`,
      size: `${(3 + Math.random() * 7).toFixed(1)}px`,
      dur: `${(380 + Math.random() * 260).toFixed(0)}ms`,
      delay: `${(Math.random() * 70).toFixed(0)}ms`,
      rot: `${(Math.random() * 180).toFixed(0)}deg`,
    };
  });
}

function makeSparks(count: number, spread: number): Spark[] {
  return Array.from({ length: count }, () => ({
    dx: `${((Math.random() - 0.5) * spread).toFixed(1)}px`,
    rise: `${(60 + Math.random() * 90).toFixed(0)}px`,
    len: `${(10 + Math.random() * 16).toFixed(0)}px`,
    dur: `${(520 + Math.random() * 300).toFixed(0)}ms`,
    delay: `${(Math.random() * 220).toFixed(0)}ms`,
  }));
}

/** Jagged fracture radiating from the impact point. */
function makeCracks(origin: SquareGeom, w: number, h: number): CrackPath[] {
  const branches = 5;
  const reach = Math.max(w, h) / branches;

  return Array.from({ length: branches }, (_, i) => {
    let a = (i / branches) * Math.PI * 2 + 0.4;
    let cx = origin.x;
    let cy = origin.y;
    let d = `M ${cx.toFixed(1)} ${cy.toFixed(1)}`;
    let len = 0;

    for (let s = 0; s < 4; s++) {
      a += (Math.random() - 0.5) * 0.85;
      const step = reach * (0.7 + Math.random() * 0.8);
      const nx = cx + Math.cos(a) * step;
      const ny = cy + Math.sin(a) * step;
      len += Math.hypot(nx - cx, ny - cy);
      d += ` L ${nx.toFixed(1)} ${ny.toFixed(1)}`;
      cx = nx;
      cy = ny;
    }

    return { d, len: Math.ceil(len) + 12, delay: i * 42 };
  });
}

/* ------------------------------------------------------------------ component */

export function FxStage({ children, ref, disabled = false }: FxStageProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const [nodes, setNodes] = useState<FxNode[]>([]);
  const [charge, setCharge] = useState<FxChargeState | null>(null);
  const [vs, setVs] = useState<FxVsState | null>(null);
  const [hp, setHp] = useState<FxHpState | null>(null);

  const idRef = useRef(0);
  const timersRef = useRef<number[]>([]);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach((t) => clearTimeout(t));
    timersRef.current = [];
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  /** Push nodes with a TTL so the overlay self-empties. */
  const push = useCallback((made: FxNodeSpec[], ttl: number) => {
    const ids: number[] = [];
    const withIds = made.map((n) => {
      const id = ++idRef.current;
      ids.push(id);
      return { ...n, id } as FxNode;
    });

    setNodes((prev) => [...prev, ...withIds]);
    timersRef.current.push(
      window.setTimeout(() => {
        setNodes((prev) => prev.filter((n) => !ids.includes(n.id)));
      }, ttl),
    );
  }, []);

  /** Body-level classes (shake, cinema) are toggled directly — they're transient
      and re-rendering the board to add a class would restart its own animations. */
  const runBodyClass = useCallback((cls: string, ms: number) => {
    const el = bodyRef.current;
    if (!el) return;
    el.classList.remove(cls);
    // Force a reflow so re-adding the class restarts the animation rather than
    // being coalesced into a no-op.
    void el.offsetWidth;
    el.classList.add(cls);
    timersRef.current.push(window.setTimeout(() => el.classList.remove(cls), ms));
  }, []);

  /**
   * Everything an effect could need, gathered in a single layout read before any
   * animation starts. This is the one-pass rule from the header comment.
   */
  const readBeat = useCallback((beat: FxBeat) => {
    // The stage, deliberately — see measure()'s note on why the overlay is wrong.
    const root = stageRef.current;
    if (!root) return null;

    const [from, to] = measure(root, [beat.from, beat.to]);
    if (!to) return null;

    const box = root.getBoundingClientRect();
    // Prefer the destination (where the mover now sits); fall back to the origin
    // for the case where the board hasn't committed the move yet.
    const art = pieceArt(root, beat.to) ?? pieceArt(root, beat.from);

    const dx = from ? to.x - from.x : 0;
    const dy = from ? to.y - from.y : 0;
    const dist = Math.hypot(dx, dy);
    // Unit vector along the move, so the shake kicks *along* the travel
    // direction — it reads as the blow landing rather than a generic rumble.
    const unit = dist || 1;

    return {
      root,
      from,
      to,
      art,
      width: box.width,
      height: box.height,
      angle: (Math.atan2(dy, dx) * 180) / Math.PI,
      dist,
      shakeX: (dx / unit) * 7,
      shakeY: (dy / unit) * 7,
    };
  }, []);

  /* --------------------------------------------------- per-effect emitters */

  const emit = useCallback(
    (effectId: string, beat: FxBeat, r: NonNullable<ReturnType<typeof readBeat>>) => {
      const heavy = beat.victim ? Math.min(1.6, 0.6 + (beat.damage ?? 1) / 6) : 0.8;
      const mutedScale = beat.muted ? 0.55 : 1;

      switch (effectId) {
        case "impact":
          push([{ k: "impact" }], 200);
          return;

        case "lines":
          push(
            [
              {
                k: "lines",
                g: { ...r.to, size: r.to.size * (5.5 * heavy) },
                rot: Math.random() * 20,
              },
            ],
            420,
          );
          return;

        case "blot":
          push([{ k: "blot", g: { ...r.to, size: r.to.size * 0.95 * heavy } }], 460);
          return;

        case "drops":
          push(
            [
              {
                k: "drops",
                g: r.to,
                drops: makeDrops(
                  Math.round(10 * heavy * mutedScale) + 4,
                  r.to.size * 2.1 * heavy,
                ),
              },
            ],
            760,
          );
          return;

        case "shake":
          bodyRef.current?.style.setProperty("--fx-sx", (r.shakeX * heavy).toFixed(2));
          bodyRef.current?.style.setProperty("--fx-sy", (r.shakeY * heavy).toFixed(2));
          runBodyClass("is-shaking", 340);
          return;

        case "streak": {
          if (!r.from || r.dist < 4) return;
          push(
            [
              {
                k: "streak",
                g: r.from,
                len: r.dist,
                angle: r.angle,
                thick: Math.max(6, r.to.size * 0.34),
                variant: "",
              },
            ],
            380,
          );
          return;
        }

        case "ghosts": {
          if (!r.from || !r.art || r.dist < 4) return;
          // Three copies at 25/50/75% of the path — enough to read as motion,
          // few enough that the board stays legible.
          push(
            [0.28, 0.52, 0.76].map((t, i) => ({
              k: "ghost" as const,
              g: {
                x: r.from!.x + (r.to.x - r.from!.x) * t,
                y: r.from!.y + (r.to.y - r.from!.y) * t,
                size: r.to.size,
              },
              art: r.art!,
              delay: i * 45,
            })),
            560,
          );
          return;
        }

        case "signature": {
          const size = r.to.size;
          switch (beat.piece) {
            case "n":
              // A knight jumps, so it blinks: a ring at both ends, no streak between.
              push(
                [
                  { k: "ring", g: { ...r.to, size }, delay: 90, ink: false },
                  ...(r.from ? [{ k: "ring" as const, g: { ...r.from, size }, delay: 0, ink: true }] : []),
                ],
                600,
              );
              return;
            case "b":
              if (!r.from) return;
              push(
                [
                  {
                    k: "streak",
                    g: r.from,
                    len: r.dist,
                    angle: r.angle,
                    thick: Math.max(8, size * 0.5),
                    variant: "er-fx-streak--slash",
                  },
                ],
                380,
              );
              return;
            case "r":
              if (!r.from) return;
              push(
                [
                  {
                    k: "streak",
                    g: r.from,
                    len: r.dist,
                    angle: r.angle,
                    thick: Math.max(10, size * 0.42),
                    variant: "er-fx-streak--heavy",
                  },
                  { k: "slamBar", g: { ...r.to, size: size * 1.25 }, angle: r.angle + 90 },
                ],
                420,
              );
              return;
            case "q":
              if (!r.from) return;
              push(
                [
                  {
                    k: "streak",
                    g: r.from,
                    len: r.dist,
                    angle: r.angle,
                    thick: Math.max(12, size * 0.62),
                    variant: "er-fx-streak--beam",
                  },
                  { k: "ring", g: { ...r.to, size: size * 1.15 }, delay: 60, ink: false },
                ],
                560,
              );
              return;
            case "k":
              push([{ k: "ring", g: { ...r.to, size: size * 1.3 }, delay: 0, ink: true }], 560);
              return;
            default:
              if (!r.from) return;
              push(
                [
                  {
                    k: "streak",
                    g: r.from,
                    len: r.dist,
                    angle: r.angle,
                    thick: Math.max(5, size * 0.22),
                    variant: "",
                  },
                ],
                340,
              );
              return;
          }
        }

        case "vignette":
          push([{ k: "vignette" }], 800);
          return;

        case "alarm":
          push([{ k: "alarm", g: r.to }], 720);
          return;

        case "callout": {
          if (!beat.callout) return;
          const threat =
            beat.kind === "check" ||
            beat.kind === "mate" ||
            beat.kind === "counter" ||
            beat.kind === "promotion";
          push(
            [
              {
                k: "callout",
                text: beat.callout,
                kicker: beat.calloutKicker,
                hold: beat.kind === "mate" ? 1500 : 820,
                ink: !threat,
                muted: Boolean(beat.muted),
              },
            ],
            beat.kind === "mate" ? 2000 : 1250,
          );
          return;
        }

        case "pillar":
          push(
            [
              { k: "pillar", g: r.to },
              { k: "sparks", g: r.to, sparks: makeSparks(14, r.to.size * 1.4) },
              { k: "ring", g: { ...r.to, size: r.to.size * 1.4 }, delay: 120, ink: false },
            ],
            900,
          );
          return;

        case "cinema":
          runBodyClass("is-cinema", 2100);
          return;

        case "crack":
          push([{ k: "crack", paths: makeCracks(r.to, r.width, r.height) }], 1200);
          return;

        case "damage": {
          if (!beat.damage) return;
          push([{ k: "damage", g: r.to, text: `−${beat.damage}` }], 850);
          return;
        }

        case "combo": {
          if (!beat.combo || beat.combo < 2) return;
          push([{ k: "combo", n: beat.combo }], 1200);
          return;
        }

        default:
          return;
      }
    },
    [push, runBodyClass],
  );

  /* ------------------------------------------------------------ tier gating */

  const fire = useCallback(
    (beat: FxBeat, enabled: Set<string> | string[]) => {
      if (disabled) return;
      const on = enabled instanceof Set ? enabled : new Set(enabled);
      const r = readBeat(beat);
      if (!r) return;

      const want: string[] = [];

      // Tier 1 — the hit. Captures only.
      if (beat.tier >= 1 && beat.victim) {
        want.push("impact", "lines", "blot", "drops", "shake", "damage");
      }
      // Motion fires on any non-quiet ply, capture or not.
      if (beat.tier >= 1) want.push("streak", "ghosts", "signature", "combo");

      // Tier 2 — the threat and the title cards.
      if (beat.kind === "check" || beat.kind === "mate") want.push("vignette", "alarm");
      if (beat.kind === "promotion") want.push("pillar");
      if (beat.tier >= 2) want.push("callout");

      // Tier 3 — the finisher. Off the leash; nothing follows it.
      if (beat.tier >= 3) want.push("cinema", "crack", "impact");

      for (const id of want) if (on.has(id)) emit(id, beat, r);
    },
    [disabled, emit, readBeat],
  );

  const fireOne = useCallback(
    (effectId: string, beat: FxBeat) => {
      if (disabled) return;
      const r = readBeat(beat);
      if (!r) return;
      emit(effectId, beat, r);
    },
    [disabled, emit, readBeat],
  );

  const clear = useCallback(() => {
    clearTimers();
    setNodes([]);
    bodyRef.current?.classList.remove("is-shaking", "is-cinema");
  }, [clearTimers]);

  useImperativeHandle(
    ref,
    (): FxHandle => ({ fire, fireOne, charge: setCharge, vs: setVs, hp: setHp, clear }),
    [fire, fireOne, clear],
  );

  /* ---------------------------------------------------------------- render */

  return (
    <div ref={stageRef} className="er-fx-stage">
      <div ref={bodyRef} className="er-fx-body">
        {children}
      </div>

      <div className="er-fx-overlay" aria-hidden>
        {charge && (
          <>
            <div
              className="er-fx-charge"
              style={{
                // White searches from the bottom half, black from the top.
                ["--fx-charge-top" as string]: charge.side === "w" ? "50%" : "0%",
                ["--fx-charge-dir" as string]: charge.side === "w" ? "to top" : "to bottom",
              }}
            />
            <div
              className="er-fx-charge-rail"
              style={{ ["--fx-rail-top" as string]: charge.side === "w" ? "100%" : "0%" }}
            >
              <div
                className="er-fx-charge-fill"
                style={{ ["--fx-depth" as string]: `${Math.min(100, Math.max(0, charge.pct))}%` }}
              />
            </div>
          </>
        )}

        {hp && (
          <>
            <div className="er-fx-hp" style={{ ["--fx-hp-top" as string]: "-26px" }}>
              <span>Black</span>
              <span className="er-fx-hp-rail">
                <span
                  className={`er-fx-hp-fill${hp.hit === "b" ? " is-hit" : ""}`}
                  style={{ ["--fx-hp-pct" as string]: `${hp.black}%` }}
                />
              </span>
            </div>
            <div className="er-fx-hp" style={{ ["--fx-hp-top" as string]: "calc(100% + 12px)" }}>
              <span>White</span>
              <span className="er-fx-hp-rail">
                <span
                  className={`er-fx-hp-fill${hp.hit === "w" ? " is-hit" : ""}`}
                  style={{ ["--fx-hp-pct" as string]: `${hp.white}%` }}
                />
              </span>
            </div>
          </>
        )}

        {vs && (
          <div className="er-fx-vs">
            <div className="er-fx-vs-side er-fx-vs-side--l">
              <span className="er-fx-vs-name">{vs.whiteLabel}</span>
              <span className="er-fx-vs-elo">{vs.whiteElo ?? "White"}</span>
            </div>
            <div className="er-fx-vs-x">VS</div>
            <div className="er-fx-vs-side er-fx-vs-side--r">
              <span className="er-fx-vs-name">{vs.blackLabel}</span>
              <span className="er-fx-vs-elo">{vs.blackElo ?? "Black"}</span>
            </div>
          </div>
        )}

        {nodes.map((n) => renderNode(n))}
      </div>
    </div>
  );
}

function px(n: number): string {
  return `${n.toFixed(1)}px`;
}

function renderNode(n: FxNode): ReactNode {
  switch (n.k) {
    case "impact":
      return <div key={n.id} className="er-fx-impact" />;

    case "vignette":
      return <div key={n.id} className="er-fx-vignette" />;

    case "lines":
      return (
        <div
          key={n.id}
          className="er-fx-lines"
          style={{
            ["--fx-x" as string]: px(n.g.x),
            ["--fx-y" as string]: px(n.g.y),
            ["--fx-size" as string]: px(n.g.size),
            ["--fx-rot" as string]: `${n.rot}deg`,
          }}
        />
      );

    case "blot":
      return (
        <div
          key={n.id}
          className="er-fx-blot"
          style={{
            ["--fx-x" as string]: px(n.g.x),
            ["--fx-y" as string]: px(n.g.y),
            ["--fx-size" as string]: px(n.g.size),
          }}
        />
      );

    case "drops":
      return (
        <div key={n.id} style={{ position: "absolute", inset: 0 }}>
          {n.drops.map((d, i) => (
            <span
              key={i}
              className="er-fx-drop"
              style={{
                ["--fx-x" as string]: px(n.g.x),
                ["--fx-y" as string]: px(n.g.y),
                ["--d-dx" as string]: d.dx,
                ["--d-dy" as string]: d.dy,
                ["--d-size" as string]: d.size,
                ["--d-dur" as string]: d.dur,
                ["--d-delay" as string]: d.delay,
                ["--d-rot" as string]: d.rot,
              }}
            />
          ))}
        </div>
      );

    case "streak":
      return (
        <div
          key={n.id}
          className={`er-fx-streak ${n.variant}`.trim()}
          style={{
            ["--fx-x" as string]: px(n.g.x),
            ["--fx-y" as string]: px(n.g.y),
            ["--fx-len" as string]: px(n.len),
            ["--fx-thick" as string]: px(n.thick),
            ["--fx-angle" as string]: `${n.angle.toFixed(2)}deg`,
          }}
        />
      );

    case "ghost":
      return (
        <div
          key={n.id}
          className="er-fx-ghost"
          style={{
            ["--fx-x" as string]: px(n.g.x),
            ["--fx-y" as string]: px(n.g.y),
            ["--fx-size" as string]: px(n.g.size),
            ["--g-delay" as string]: `${n.delay}ms`,
          }}
          dangerouslySetInnerHTML={{ __html: n.art }}
        />
      );

    case "ring":
      return (
        <div
          key={n.id}
          className={`er-fx-ring${n.ink ? " er-fx-ring--ink" : ""}`}
          style={{
            ["--fx-x" as string]: px(n.g.x),
            ["--fx-y" as string]: px(n.g.y),
            ["--fx-size" as string]: px(n.g.size),
            ["--r-delay" as string]: `${n.delay}ms`,
          }}
        />
      );

    case "slamBar":
      return (
        <div
          key={n.id}
          className="er-fx-slam-bar"
          style={{
            ["--fx-x" as string]: px(n.g.x),
            ["--fx-y" as string]: px(n.g.y),
            ["--fx-size" as string]: px(n.g.size),
            ["--fx-angle" as string]: `${n.angle.toFixed(2)}deg`,
          }}
        />
      );

    case "alarm":
      return (
        <div
          key={n.id}
          className="er-fx-alarm"
          style={{
            ["--fx-x" as string]: px(n.g.x),
            ["--fx-y" as string]: px(n.g.y),
            ["--fx-size" as string]: px(n.g.size),
          }}
        />
      );

    case "callout":
      return (
        <div
          key={n.id}
          className={`er-fx-callout${n.muted ? " is-muted" : ""}`}
          style={{ ["--fx-hold" as string]: `${n.hold}ms` }}
        >
          {n.kicker && <span className="er-fx-callout-kicker">{n.kicker}</span>}
          <span className={`er-fx-callout-bar${n.ink ? " er-fx-callout-bar--ink" : ""}`}>
            {n.text}
          </span>
        </div>
      );

    case "damage":
      return (
        <div
          key={n.id}
          className="er-fx-damage"
          style={{
            ["--fx-x" as string]: px(n.g.x),
            ["--fx-y" as string]: px(n.g.y),
          }}
        >
          {n.text}
        </div>
      );

    case "combo":
      return (
        <div key={n.id} className="er-fx-combo">
          <b>{n.n}</b>
          <span>hit</span>
        </div>
      );

    case "pillar":
      return (
        <div
          key={n.id}
          className="er-fx-pillar"
          style={{
            ["--fx-x" as string]: px(n.g.x),
            ["--fx-size" as string]: px(n.g.size),
          }}
        />
      );

    case "sparks":
      return (
        <div key={n.id} style={{ position: "absolute", inset: 0 }}>
          {n.sparks.map((s, i) => (
            <span
              key={i}
              className="er-fx-spark"
              style={{
                ["--fx-x" as string]: px(n.g.x),
                ["--fx-y" as string]: px(n.g.y),
                ["--s-dx" as string]: s.dx,
                ["--s-rise" as string]: s.rise,
                ["--s-len" as string]: s.len,
                ["--s-dur" as string]: s.dur,
                ["--s-delay" as string]: s.delay,
              }}
            />
          ))}
        </div>
      );

    case "crack":
      return (
        <svg key={n.id} className="er-fx-crack">
          {n.paths.map((p, i) => (
            <path
              key={i}
              d={p.d}
              style={{
                ["--c-len" as string]: String(p.len),
                ["--c-delay" as string]: `${p.delay}ms`,
              }}
            />
          ))}
        </svg>
      );
  }
}


