/**
 * Shapes for the fight-FX layer. Deliberately independent of chess.js and of
 * React: `classify()` turns a move into one of these, and the render layer only
 * ever reads them. That split is what lets the tier logic be unit-checked
 * without a DOM and lets the lab fire beats that no real game produced.
 */

/** How loud a ply is allowed to be. See BEAT_DELAY_MS for what each costs. */
export type FxTier = 0 | 1 | 2 | 3;

export type FxKind =
  | "quiet"
  | "capture"
  | "check"
  | "castle"
  | "promotion"
  | "counter"
  | "mate";

/** chess.js piece letters, lowercase regardless of colour. */
export type FxPiece = "p" | "n" | "b" | "r" | "q" | "k";

export interface FxBeat {
  tier: FxTier;
  kind: FxKind;
  /** Origin square, e.g. "e2". The vector from→to drives every directional effect. */
  from: string;
  to: string;
  piece: FxPiece;
  color: "w" | "b";
  /** What got taken, if anything. Drives spatter volume and the damage number. */
  victim?: FxPiece;
  /** Material swing in pawns, for the damage number. */
  damage?: number;
  /** Big text: an opening name, "DANGER", "COUNTER". */
  callout?: string;
  /** Kicker line above the callout. */
  calloutKicker?: string;
  /** Consecutive-capture count, 2+ only. */
  combo?: number;
  /** True when this beat belongs to the human in User 1v1 — their hits land harder. */
  mine?: boolean;
  /**
   * Render at reduced weight. Set by the "play" profile for the engine's own
   * moves: same tier and timing, less ink on screen, so the board you're
   * actually playing on never gets buried.
   */
  muted?: boolean;
}

/**
 * Running state `classify()` needs but a single move can't carry: recapture
 * detection and the combo tally both depend on the previous ply.
 */
export interface FxContext {
  /** Square of the immediately preceding capture, if the last ply was one. */
  lastCaptureSquare: string | null;
  /** How many plies in a row have been captures. */
  comboCount: number;
  /** Last opening name put on screen, so the same one can't announce twice. */
  lastOpeningName: string | null;
  /** Opening title cards spent this game, against MAX_OPENING_CALLOUTS. */
  openingCallouts: number;
}

export function freshFxContext(): FxContext {
  return {
    lastCaptureSquare: null,
    comboCount: 0,
    lastOpeningName: null,
    openingCallouts: 0,
  };
}
