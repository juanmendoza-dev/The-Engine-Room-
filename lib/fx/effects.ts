import type { FxTier } from "./types";

/**
 * The pickable effect list. Shared between FxStage (which decides what a beat
 * emits) and the FX lab (which renders one row per entry), so the two can't
 * drift out of sync.
 */

export type FxGroup = "hit" | "motion" | "threat" | "moment" | "hud";

export interface FxEffectDef {
  id: string;
  label: string;
  blurb: string;
  /** Lowest tier that fires this automatically. 9 = manual only (not ply-driven). */
  tier: FxTier | 9;
  group: FxGroup;
  /** The anime device it's standing in for, shown in the lab. */
  device: string;
}

export const FX_EFFECTS: FxEffectDef[] = [
  // --- the hit ---
  {
    id: "impact",
    label: "Impact frame",
    blurb: "Two-frame full inversion of the board. The sakuga punch.",
    tier: 1,
    group: "hit",
    device: "Impact frame",
  },
  {
    id: "lines",
    label: "Focus lines",
    blurb: "Manga convergence lines collapsing onto the landing square.",
    tier: 1,
    group: "hit",
    device: "Speed / focus lines",
  },
  {
    id: "blot",
    label: "Ink blot",
    blurb: "Red ink strikes the capture square and bleeds out.",
    tier: 1,
    group: "hit",
    device: "Blood hit",
  },
  {
    id: "drops",
    label: "Ink spatter",
    blurb: "Droplets thrown outward from the kill, volume scaled to the piece.",
    tier: 1,
    group: "hit",
    device: "Blood spray",
  },
  {
    id: "shake",
    label: "Screen shake",
    blurb: "Board kicks along the capture vector, not randomly.",
    tier: 1,
    group: "hit",
    device: "Camera shake",
  },

  // --- the motion ---
  {
    id: "streak",
    label: "Smear streak",
    blurb: "Motion smear drawn along the move vector.",
    tier: 1,
    group: "motion",
    device: "Smear frame",
  },
  {
    id: "ghosts",
    label: "Afterimage",
    blurb: "Real cloned piece art dropped along the path behind the mover.",
    tier: 1,
    group: "motion",
    device: "Afterimage",
  },
  {
    id: "signature",
    label: "Signature attacks",
    blurb:
      "Per-piece move: knight blinks, bishop slashes, rook pile-drives, queen fires a beam, king steps heavy.",
    tier: 1,
    group: "motion",
    device: "Character move list",
  },

  // --- the threat ---
  {
    id: "vignette",
    label: "Danger vignette",
    blurb: "Red pulses in from the board edges, twice, on check.",
    tier: 2,
    group: "threat",
    device: "Danger flash",
  },
  {
    id: "alarm",
    label: "King alarm",
    blurb: "The exposed king's square outlines red and jitters.",
    tier: 2,
    group: "threat",
    device: "Target lock",
  },

  // --- the moments ---
  {
    id: "callout",
    label: "Attack-name callout",
    blurb:
      "Slammed title card. Real opening names as attack names — plus DANGER, COUNTER, ASCENSION, CHECKMATE.",
    tier: 2,
    group: "moment",
    device: "Attack name shout",
  },
  {
    id: "pillar",
    label: "Promotion pillar",
    blurb: "Column of light and rising sparks when a pawn reforges.",
    tier: 2,
    group: "moment",
    device: "Transformation sequence",
  },
  {
    id: "cinema",
    label: "Finisher slow-mo",
    blurb: "Desaturate, crush contrast, push the camera in. Mate only.",
    tier: 3,
    group: "moment",
    device: "Finishing blow",
  },
  {
    id: "crack",
    label: "Screen crack",
    blurb: "Fracture lines draw out from the mating square.",
    tier: 3,
    group: "moment",
    device: "Screen break",
  },

  // --- the HUD ---
  {
    id: "damage",
    label: "Damage number",
    blurb: "Material value floats off the captured piece. −9 for a queen.",
    tier: 1,
    group: "hud",
    device: "Damage number",
  },
  {
    id: "combo",
    label: "Combo counter",
    blurb: "Consecutive capturing plies tally in the corner.",
    tier: 1,
    group: "hud",
    device: "Hit counter",
  },
  {
    id: "charge",
    label: "Ki charge",
    blurb: "Aura on the searching side's half — the bar is real Stockfish search depth.",
    tier: 9,
    group: "hud",
    device: "Power-up charge",
  },
  {
    id: "hp",
    label: "HP bars",
    blurb: "Material as health. Flashes red when a side takes damage.",
    tier: 9,
    group: "hud",
    device: "Fighting-game health bar",
  },
  {
    id: "vs",
    label: "VS pre-fight card",
    blurb: "Both engines slam in from opposite sides, ELO as power level, diagonal wipe out.",
    tier: 9,
    group: "moment",
    device: "Pre-fight title card",
  },
];

export const FX_GROUP_LABELS: Record<FxGroup, string> = {
  hit: "The hit",
  motion: "The motion",
  threat: "The threat",
  moment: "The moments",
  hud: "The HUD",
};

export const ALL_FX_IDS = FX_EFFECTS.map((e) => e.id);
