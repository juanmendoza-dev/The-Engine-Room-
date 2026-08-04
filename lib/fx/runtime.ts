"use client";

import type { Chess } from "chess.js";
import { useEffect, useState } from "react";

import type { FxPiece } from "./types";

/**
 * Shared runtime helpers for the fight-FX layer, so Model 1v1 and User 1v1 don't
 * each grow their own copy.
 */

/** Material value in pawns. Kings excluded — they're never captured. */
const PIECE_VALUE: Record<FxPiece, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** Full starting material per side, minus the king: 8 + 6 + 6 + 10 + 9. */
const FULL_MATERIAL = 39;

/**
 * Is the effects layer allowed to run?
 *
 * Two opt-outs, both deliberate:
 * - `prefers-reduced-motion` — globals.css already collapses CSS animation
 *   durations to ~0, but that would leave effects *rendering* as static frames
 *   stacked on the board. This turns them off at the source instead.
 * - `?fx=off` — an escape hatch for the CDP verification harnesses. Driving a
 *   board through `Input.dispatchMouseEvent` while impact frames and spatter are
 *   painting over it is a way to lose an afternoon; `deployment.md` §4 already
 *   documents the neighbouring traps.
 *
 * Starts false and enables after mount: `matchMedia` and `location` don't exist
 * during SSR, and rendering effects-on then flipping off would be a hydration
 * mismatch on every reduced-motion visitor.
 */
export function useFxEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const off = new URLSearchParams(window.location.search).get("fx") === "off";
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");

    const sync = () => setEnabled(!off && !media.matches);
    sync();

    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  return enabled;
}

/**
 * Material as a 0-100 rail per side — the HP bars. Not an evaluation: it ignores
 * position entirely, which is the point. A fighting-game health bar should track
 * "what have you lost", not "who is winning", or it would swing on every quiet
 * positional move and stop reading as damage.
 */
export function materialHp(chess: Chess): { white: number; black: number } {
  let white = 0;
  let black = 0;

  for (const row of chess.board()) {
    for (const square of row) {
      if (!square) continue;
      const value = PIECE_VALUE[square.type as FxPiece] ?? 0;
      if (square.color === "w") white += value;
      else black += value;
    }
  }

  return {
    white: Math.round((white / FULL_MATERIAL) * 100),
    black: Math.round((black / FULL_MATERIAL) * 100),
  };
}

/**
 * Search depth → charge percentage. Stockfish reaches roughly depth 13-16 inside
 * its 500ms budget on the lite build (measured in the Task 2 spike), so 18 is a
 * ceiling that keeps the bar climbing for the whole search instead of pinning at
 * full a third of the way in.
 */
export function depthToPct(depth: number): number {
  return Math.min(100, Math.round((depth / 18) * 100));
}

/**
 * Maia has no search and therefore no depth, so its charge can't be driven by
 * telemetry. Caps below 100 on purpose: a bar that fills completely reads as
 * "finished", and this one is only saying "still working".
 */
export const INDETERMINATE_CHARGE_PCT = 62;
