/**
 * Decorative mid-game position for the hero — a static "photo", not a real
 * board. The playable board comes from react-chessboard in a later task; this
 * one is deliberately dependency-free so the landing page stays light.
 *
 * Position and last-move highlight are lifted from docs/design/hero-preview.html.
 */

const POSITION = [
  "r.bq.rk.",
  "ppp..ppp",
  "..np.n..",
  "..b.p...",
  "..B.P...",
  "...P.N..",
  "PPP..PPP",
  "RNBQ.RK.",
] as const;

const GLYPHS: Record<string, string> = {
  K: "♔",
  Q: "♕",
  R: "♖",
  B: "♗",
  N: "♘",
  P: "♙",
  k: "♚",
  q: "♛",
  r: "♜",
  b: "♝",
  n: "♞",
  p: "♟",
};

// Last move played: bishop f1 -> c4. Both squares pulse.
const HIGHLIGHTED = new Set([4 * 8 + 2, 7 * 8 + 5]);

const WHITE_SHADOW = "0 1px 3px rgba(0,0,0,0.6)";
const BLACK_SHADOW = "0 0 5px rgba(201,151,74,0.45), 0 1px 0 rgba(255,255,255,0.10)";

export function MiniBoard() {
  const squares = POSITION.flatMap((row, r) =>
    row.split("").map((piece, c) => {
      const index = r * 8 + c;
      const isEmpty = piece === ".";
      const isWhite = !isEmpty && piece === piece.toUpperCase();

      return {
        index,
        glyph: isEmpty ? "" : GLYPHS[piece],
        isLightSquare: (r + c) % 2 === 0,
        isWhite,
        isHighlighted: HIGHLIGHTED.has(index),
      };
    }),
  );

  return (
    <div className="er-board grid grid-cols-8 overflow-hidden rounded-[4px]">
      {squares.map((sq) => (
        <div
          key={sq.index}
          className={`grid aspect-square place-items-center text-[clamp(18px,3.2vw,27px)] leading-none ${
            sq.isHighlighted ? "er-square--hi" : ""
          }`}
          style={{
            background: sq.isLightSquare ? "var(--er-sq-light)" : "var(--er-sq-dark)",
            color: sq.isWhite ? "var(--er-sq-white-piece)" : "var(--er-sq-black-piece)",
            textShadow: sq.isWhite ? WHITE_SHADOW : BLACK_SHADOW,
          }}
        >
          {sq.glyph}
        </div>
      ))}
    </div>
  );
}
