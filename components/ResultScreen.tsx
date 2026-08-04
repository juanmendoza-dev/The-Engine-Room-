interface Props {
  result: "1-0" | "0-1" | "1/2-1/2";
  endReason: string;
  whiteLabel: string;
  blackLabel: string;
  onRematch?: () => void;
}

const REASON_COPY: Record<string, string> = {
  checkmate: "by checkmate",
  stalemate: "by stalemate",
  "draw-repetition": "by threefold repetition",
  "draw-50move": "by the fifty-move rule",
  "draw-insufficient": "by insufficient material",
};

// "Stockfish 2800 wins", but never "You wins" — User 1v1 labels the human "You".
function winsCopy(label: string) {
  return label === "You" ? "You win" : `${label} wins`;
}

export function ResultScreen({ result, endReason, whiteLabel, blackLabel, onRematch }: Props) {
  const summary =
    result === "1/2-1/2" ? "Draw" : result === "1-0" ? winsCopy(whiteLabel) : winsCopy(blackLabel);

  return (
    <div className="border-er-line bg-er-surface flex flex-wrap items-center justify-between gap-4 border px-6 py-5">
      <div>
        <h2 className="font-display-black text-[24px] tracking-[-0.01em] uppercase">{summary}</h2>
        <p className="text-er-dim mt-1 font-mono text-[11px] tracking-[0.18em] uppercase">
          {result} · {REASON_COPY[endReason] ?? endReason}
        </p>
      </div>
      {onRematch && (
        <button
          onClick={onRematch}
          className="border-er-accent text-er-accent hover:bg-er-accent hover:text-er-bg cursor-pointer border px-5 py-2 font-mono text-[12px] tracking-[0.16em] uppercase transition-colors"
        >
          Run it again
        </button>
      )}
    </div>
  );
}
