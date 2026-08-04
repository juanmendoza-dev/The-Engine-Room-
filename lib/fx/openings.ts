/**
 * Opening names as shonen attack names.
 *
 * The whole gag rests on the fact that real chess openings are *already* named
 * like finishing moves — "Sicilian Defence: Dragon Variation", "King's Indian
 * Attack", "Grob's Attack". No invention required; the table below is just the
 * standard names, and the callout renders them in Archivo Black like an attack
 * title card.
 *
 * Matching is longest-prefix so a line that's still in the trunk gets the broad
 * name and one that's committed gets the specific one. Nowhere near a full
 * opening book — a hackathon-sized table that covers what two Stockfish presets
 * actually play, plus the Opera Game line the lab replays.
 */

interface OpeningEntry {
  /** SAN plies from move 1, in order. */
  line: string[];
  name: string;
  /** Small line above the name. Flavour, not data. */
  kicker: string;
}

const OPENINGS: OpeningEntry[] = [
  // First moves — the fallback tier, so something always fires.
  { line: ["e4"], name: "King's Pawn", kicker: "Opening stance" },
  { line: ["d4"], name: "Queen's Pawn", kicker: "Opening stance" },
  { line: ["Nf3"], name: "Réti Opening", kicker: "Opening stance" },
  { line: ["c4"], name: "English Opening", kicker: "Opening stance" },
  { line: ["f4"], name: "Bird's Opening", kicker: "Opening stance" },
  { line: ["b4"], name: "Polish Opening", kicker: "Opening stance" },
  { line: ["g4"], name: "Grob's Attack", kicker: "Reckless" },

  // 1.e4
  { line: ["e4", "e5"], name: "Open Game", kicker: "Both blades drawn" },
  { line: ["e4", "c5"], name: "Sicilian Defence", kicker: "Counter-stance" },
  { line: ["e4", "e6"], name: "French Defence", kicker: "Counter-stance" },
  { line: ["e4", "c6"], name: "Caro-Kann Defence", kicker: "Counter-stance" },
  { line: ["e4", "d5"], name: "Scandinavian Defence", kicker: "Immediate strike" },
  { line: ["e4", "Nf6"], name: "Alekhine's Defence", kicker: "Provocation" },
  { line: ["e4", "d6"], name: "Pirc Defence", kicker: "Coiled" },
  { line: ["e4", "g6"], name: "Modern Defence", kicker: "Coiled" },

  { line: ["e4", "c5", "Nf3", "d6"], name: "Sicilian · Najdorf", kicker: "Dragon's cousin" },
  { line: ["e4", "c5", "Nf3", "Nc6"], name: "Sicilian · Old Line", kicker: "Classical" },
  { line: ["e4", "c5", "Nf3", "g6"], name: "Sicilian · Dragon", kicker: "Serpent rising" },
  { line: ["e4", "c5", "d4"], name: "Smith-Morra Gambit", kicker: "Blood offering" },
  { line: ["e4", "c5", "Nc3"], name: "Closed Sicilian", kicker: "Slow burn" },

  { line: ["e4", "e5", "Nf3", "Nc6", "Bb5"], name: "Ruy López", kicker: "The Spanish Torture" },
  { line: ["e4", "e5", "Nf3", "Nc6", "Bc4"], name: "Italian Game", kicker: "Classical" },
  { line: ["e4", "e5", "Nf3", "Nc6", "d4"], name: "Scotch Game", kicker: "Centre broken" },
  { line: ["e4", "e5", "Nf3", "Nf6"], name: "Petrov's Defence", kicker: "Mirror match" },
  { line: ["e4", "e5", "Nf3", "d6"], name: "Philidor Defence", kicker: "Old guard" },
  { line: ["e4", "e5", "f4"], name: "King's Gambit", kicker: "Reckless" },
  { line: ["e4", "e5", "Nc3"], name: "Vienna Game", kicker: "Patient" },
  { line: ["e4", "e5", "Bc4"], name: "Bishop's Opening", kicker: "Early aim" },

  // 1.d4
  { line: ["d4", "d5", "c4"], name: "Queen's Gambit", kicker: "Bait" },
  { line: ["d4", "d5", "c4", "dxc4"], name: "Queen's Gambit Accepted", kicker: "Bait taken" },
  { line: ["d4", "d5", "c4", "e6"], name: "Queen's Gambit Declined", kicker: "Bait refused" },
  { line: ["d4", "d5", "c4", "c6"], name: "Slav Defence", kicker: "Fortress" },
  { line: ["d4", "d5", "Nf3"], name: "Zukertort Opening", kicker: "Quiet" },
  { line: ["d4", "Nf6", "c4", "g6"], name: "King's Indian Defence", kicker: "Storm gathering" },
  { line: ["d4", "Nf6", "c4", "e6"], name: "Indian Complex", kicker: "Flexible guard" },
  { line: ["d4", "f5"], name: "Dutch Defence", kicker: "Wing strike" },
  { line: ["d4", "e5"], name: "Englund Gambit", kicker: "Reckless" },

  // 1.Nf3 / 1.c4
  { line: ["Nf3", "d5", "g3"], name: "King's Indian Attack", kicker: "Coiled spring" },
  { line: ["c4", "e5"], name: "English · Reversed Sicilian", kicker: "Mirrored" },
  { line: ["c4", "c5"], name: "English · Symmetrical", kicker: "Standoff" },
];

export interface OpeningCallout {
  name: string;
  kicker: string;
  /** How many plies matched — the caller uses this to only fire on a *new* name. */
  depth: number;
}

/**
 * Longest-prefix match against the moves played so far. Returns null before any
 * move and for lines the table doesn't reach.
 */
export function identifyOpening(sanMoves: string[]): OpeningCallout | null {
  let best: OpeningCallout | null = null;

  for (const entry of OPENINGS) {
    if (entry.line.length > sanMoves.length) continue;
    const matches = entry.line.every((san, i) => san === sanMoves[i]);
    if (!matches) continue;
    if (best && entry.line.length <= best.depth) continue;
    best = { name: entry.name, kicker: entry.kicker, depth: entry.line.length };
  }

  return best;
}

/**
 * Deepest line in the table, so a caller can stop asking once it's past any
 * possible match rather than scanning the table every ply for a whole game.
 */
export const MAX_OPENING_DEPTH = OPENINGS.reduce((max, e) => Math.max(max, e.line.length), 0);
