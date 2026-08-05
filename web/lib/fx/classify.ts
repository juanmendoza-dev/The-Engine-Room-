import { identifyOpening, MAX_OPENING_DEPTH } from "./openings";
import type { FxBeat, FxContext, FxPiece, FxTier } from "./types";

/**
 * The tier ladder. Every ply gets a number 0-3 and that number decides both what
 * renders and how long the game pauses for it.
 *
 * The ladder exists because the failure mode of an effects layer is uniformity:
 * if every move screams, nothing lands, and a 60-ply game becomes noise. Most
 * plies are deliberately tier 0 and render nothing at all — that's what buys the
 * captures their impact.
 */

/** Material value in pawns. Kings are 0: you never capture one. */
const PIECE_VALUE: Record<FxPiece, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/**
 * How long the game loop waits after each tier, in ms.
 *
 * Tier 0 is the existing `moveDelayMs` default, unchanged, so a quiet game plays
 * at exactly the speed it does today. Everything above it is the hit-stop: the
 * pause *is* the effect, which is the one thing a fixed delay can't fake. Tier 3
 * is off the leash because the game is over — there's no next ply to overlap.
 */
export const BEAT_DELAY_MS: Record<FxTier, number> = {
  0: 350,
  1: 470,
  2: 700,
  3: 2000,
};

export function beatDelay(beat: FxBeat): number {
  return BEAT_DELAY_MS[beat.tier];
}

/**
 * Which screen this is for.
 * - `spectate` (Model 1v1): you're an audience, so full ceiling.
 * - `play` (User 1v1): you're a participant. Same tiers and timing, but the
 *   engine's moves render muted so the board never gets buried while it's your
 *   turn to look at it.
 */
export type FxProfile = "spectate" | "play";

/** Announce at most this many openings per game — one is a title card, four is a lecture. */
const MAX_OPENING_CALLOUTS = 2;

export interface ClassifyInput {
  /** The verbose move chess.js already returns from `.move()` and currently throws away. */
  move: {
    from: string;
    to: string;
    piece: string;
    color: "w" | "b";
    captured?: string;
    promotion?: string;
    san: string;
    flags: string;
  };
  /** Position state *after* the move. Read off the same Chess instance the caller already has. */
  isCheck: boolean;
  isCheckmate: boolean;
  /** Every SAN played so far, this move included. Drives the opening callout. */
  sanHistory: string[];
  /** True when the human played this. Only meaningful under the `play` profile. */
  mine?: boolean;
}

/**
 * Turns one move into one beat. Pure — no DOM, no chess.js instance, no React —
 * so the tier rules can be reasoned about and checked in isolation. `ctx` is
 * mutated in place because recapture and combo detection are inherently stateful
 * across plies.
 */
export function classify(
  input: ClassifyInput,
  ctx: FxContext,
  profile: FxProfile = "spectate",
): FxBeat {
  const { move, isCheck, isCheckmate, sanHistory, mine } = input;

  const piece = move.piece as FxPiece;
  const victim = move.captured as FxPiece | undefined;
  const isCapture = Boolean(victim) || move.flags.includes("c") || move.flags.includes("e");
  const isCastle = move.flags.includes("k") || move.flags.includes("q");
  const isPromotion = Boolean(move.promotion) || move.flags.includes("p");

  // Recapture: the previous ply took something on the square this one just took
  // on. That's a parry-riposte, and it reads completely differently from an
  // opening capture even though the move data looks identical.
  const isCounter = isCapture && ctx.lastCaptureSquare === move.to;

  let tier: FxTier = 0;
  let kind: FxBeat["kind"] = "quiet";

  if (isCapture) {
    tier = 1;
    kind = "capture";
  }
  if (isCastle) {
    tier = 2;
    kind = "castle";
  }
  if (isCapture && victim && PIECE_VALUE[victim] >= 5) {
    // Losing a rook or queen is a structural event, not a trade.
    tier = 2;
  }
  if (isPromotion) {
    tier = 2;
    kind = "promotion";
  }
  if (isCounter) {
    tier = 2;
    kind = "counter";
  }
  if (isCheck) {
    tier = 2;
    kind = "check";
  }
  if (isCheckmate) {
    tier = 3;
    kind = "mate";
  }

  // Combo runs on consecutive capturing plies regardless of colour — a long
  // trade sequence is the chess equivalent of a exchange of blows.
  ctx.comboCount = isCapture ? ctx.comboCount + 1 : 0;
  ctx.lastCaptureSquare = isCapture ? move.to : null;

  const beat: FxBeat = {
    tier,
    kind,
    from: move.from,
    to: move.to,
    piece,
    color: move.color,
    victim,
    damage: victim ? PIECE_VALUE[victim] : undefined,
    combo: ctx.comboCount >= 2 ? ctx.comboCount : undefined,
    mine,
  };

  // Callout priority, loudest first. Only one line of big text at a time.
  if (isCheckmate) {
    beat.callout = "CHECKMATE";
    beat.calloutKicker = move.color === "w" ? "White finishes it" : "Black finishes it";
  } else if (isCounter) {
    beat.callout = "COUNTER";
    beat.calloutKicker = "Riposte";
  } else if (isCheck) {
    beat.callout = "DANGER";
    beat.calloutKicker = "King exposed";
  } else if (isPromotion) {
    beat.callout = "ASCENSION";
    beat.calloutKicker = "Pawn reforged";
  } else {
    // Openings only get the stage when nothing louder wants it.
    const opening = maybeAnnounceOpening(sanHistory, ctx);
    if (opening) {
      beat.callout = opening.name.toUpperCase();
      beat.calloutKicker = opening.kicker;
      // A title card with no pause reads as a glitch, so the reveal buys tier 2.
      if (beat.tier < 2) beat.tier = 2;
    }
  }

  if (profile === "play" && !mine && beat.kind !== "mate") beat.muted = true;

  return beat;
}

/**
 * Opening names fire on *change*, capped per game. Without the change check every
 * ply in the book re-announces the same line; without the cap a long theoretical
 * opening throws four title cards before anyone has taken a piece.
 */
function maybeAnnounceOpening(sanHistory: string[], ctx: FxContext) {
  if (sanHistory.length > MAX_OPENING_DEPTH) return null;
  if (ctx.openingCallouts >= MAX_OPENING_CALLOUTS) return null;

  const found = identifyOpening(sanHistory);
  // Depth 1 is just "someone pushed a pawn" — not worth a title card.
  if (!found || found.depth < 2) return null;
  if (found.name === ctx.lastOpeningName) return null;

  ctx.lastOpeningName = found.name;
  ctx.openingCallouts += 1;
  return found;
}
