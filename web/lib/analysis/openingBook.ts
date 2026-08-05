// A randomized opening book, so that N games between two presets are N games and
// not one game replayed N times.
//
// This is the load-bearing piece of the whole SPRT exercise, and it is easy to
// underrate. Maia is *exactly* deterministic — `getMaiaMove` takes the argmax of
// a softmax over legal moves, a pure function of (fen, ratingTier), so the same
// position gives the same move forever. Stockfish has some variance but it is
// accidental: `go movetime 500` is a wall-clock search, so timing jitter can flip
// a close call and nothing else can. Task 2's own two-run sample saw 1320 agree
// with itself and 2800 disagree. That variance cannot be seeded, sized, or relied
// on. Without a book, the effective sample size of a 320-game match is somewhere
// between 1 and "small and unknown", and every confidence interval downstream is
// decoration.
//
// The fix costs nothing and touches neither engine: play a prescribed opening
// first, then hand over. A deterministic engine still produces a distinct game
// per distinct opening, because the *positions* differ.
//
// **This is the placeholder the spec asks for.** `2026-08-05-opening-trie.md`
// is supposed to own the real structure and does not exist in the repo (checked).
// What's here satisfies the size and depth minimums the SPRT spec sets and
// nothing more: ~16+ structurally distinct lines, 4–8 plies each.
//
// Spec: docs/specs/2026-08-05-sprt-engine-ratings.md ("The determinism problem")

import type { OpeningLine } from "./types";

/**
 * Twenty-one lines, chosen for *structural* variety rather than count: different
 * first moves and different resulting pawn structures, not move-order
 * permutations of the same middlegame. Two lines that transpose are one line for
 * decorrelation purposes however different their move lists look, which is why
 * this is 1.e4/1.d4/1.c4/1.Nf3/1.f4 spread across defences rather than twenty
 * flavours of the Sicilian.
 *
 * All even length, so White is always the side to move when the engines take
 * over. That keeps a colour-swapped pair of games exactly symmetric.
 *
 * Sizing, from the spec: at ~22 games (a wide-gap sanity check) even 8 lines
 * keeps expected repeats under 3; at ~320 games (the precision case) 16 lines
 * averages ~20 repeats each. 21 buys a little margin on the second case. A
 * repeated line is still a repeated game, so if this book ever shrinks, that is
 * the number to recheck.
 */
export const OPENING_BOOK: OpeningLine[] = [
  { id: "ruy-lopez", name: "Ruy Lopez, Morphy", san: ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"] },
  { id: "italian", name: "Italian Game", san: ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"] },
  { id: "scotch", name: "Scotch Game", san: ["e4", "e5", "Nf3", "Nc6", "d4", "exd4", "Nxd4", "Bc5"] },
  { id: "kings-gambit", name: "King's Gambit Accepted", san: ["e4", "e5", "f4", "exf4", "Nf3", "g5"] },
  { id: "vienna", name: "Vienna Game", san: ["e4", "e5", "Nc3", "Nf6", "f4", "d5"] },
  { id: "sicilian-open", name: "Sicilian, Open", san: ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6"] },
  { id: "sicilian-alapin", name: "Sicilian, Alapin", san: ["e4", "c5", "c3", "Nf6", "e5", "Nd5"] },
  { id: "french", name: "French, Winawer", san: ["e4", "e6", "d4", "d5", "Nc3", "Bb4"] },
  { id: "caro-kann", name: "Caro-Kann", san: ["e4", "c6", "d4", "d5", "Nc3", "dxe4"] },
  { id: "scandinavian", name: "Scandinavian", san: ["e4", "d5", "exd5", "Qxd5", "Nc3", "Qa5"] },
  { id: "pirc", name: "Pirc Defence", san: ["e4", "d6", "d4", "Nf6", "Nc3", "g6"] },
  { id: "alekhine", name: "Alekhine's Defence", san: ["e4", "Nf6", "e5", "Nd5", "d4", "d6"] },
  { id: "qgd", name: "Queen's Gambit Declined", san: ["d4", "d5", "c4", "e6", "Nc3", "Nf6"] },
  { id: "slav", name: "Slav Defence", san: ["d4", "d5", "c4", "c6", "Nf3", "Nf6"] },
  { id: "qga", name: "Queen's Gambit Accepted", san: ["d4", "d5", "c4", "dxc4", "Nf3", "Nf6"] },
  { id: "kings-indian", name: "King's Indian", san: ["d4", "Nf6", "c4", "g6", "Nc3", "Bg7", "e4", "d6"] },
  { id: "nimzo-indian", name: "Nimzo-Indian", san: ["d4", "Nf6", "c4", "e6", "Nc3", "Bb4"] },
  { id: "grunfeld", name: "Grünfeld", san: ["d4", "Nf6", "c4", "g6", "Nc3", "d5"] },
  { id: "dutch", name: "Dutch Defence", san: ["d4", "f5", "g3", "Nf6", "Bg2", "e6"] },
  { id: "english", name: "English, Reversed Sicilian", san: ["c4", "e5", "Nc3", "Nf6", "g3", "d5", "cxd5", "Nxd5"] },
  { id: "reti", name: "Réti Opening", san: ["Nf3", "d5", "g3", "Nf6", "Bg2", "c5"] },
];

/**
 * Deterministic RNG (mulberry32) so a whole match can be reproduced from its
 * seed. Worth having: a rating that came out strange is worth re-running with
 * the same openings before deciding the engines did something interesting.
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform pick with replacement, as the spec specifies. No weighting. */
export function pickOpening(rng: () => number, book: OpeningLine[] = OPENING_BOOK): OpeningLine {
  return book[Math.floor(rng() * book.length) % book.length];
}

/**
 * Uniform *without* replacement: hand out a seeded shuffle of the whole book,
 * then reshuffle once it runs out.
 *
 * This is what the match runner uses, and it is a deliberate deviation from the
 * spec's "uniform pick". Picking with replacement over 21 lines means a 30-game
 * match samples ~15 openings and draws some of them twice — and a repeated
 * opening against deterministic engines is not a second game, it is the same
 * game logged twice. The spec knows this ("a repeated line is still a repeated
 * game") and answers it by making the book big enough that repeats are rare.
 * Dealing from a shuffled deck makes them impossible until the deck is empty,
 * which is strictly better for the same book size, and is still uniform.
 *
 * Reshuffling rather than stopping matters for the 320-game precision case,
 * where the deck genuinely does run out.
 */
export function makeOpeningDealer(
  rng: () => number,
  book: OpeningLine[] = OPENING_BOOK,
): () => OpeningLine {
  let deck: OpeningLine[] = [];

  return function deal(): OpeningLine {
    if (deck.length === 0) {
      deck = [...book];
      // Fisher-Yates off the same seeded rng, so a whole match still replays.
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
    }
    return deck.pop() as OpeningLine;
  };
}
