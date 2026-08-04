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

export function ResultScreen({ result, endReason, whiteLabel, blackLabel, onRematch }: Props) {
  const summary =
    result === "1/2-1/2" ? "Draw" : result === "1-0" ? `${whiteLabel} wins` : `${blackLabel} wins`;

  return (
    <div className="border-er-line bg-er-surface flex flex-wrap items-center justify-between gap-4 rounded-[10px] border px-6 py-5">
      <div>
        <h2 className="text-[24px] font-semibold tracking-[-0.01em]">{summary}</h2>
        <p className="text-er-dim mt-1 font-mono text-[11px] tracking-[0.18em] uppercase">
          {result} · {REASON_COPY[endReason] ?? endReason}
        </p>
      </div>
      {onRematch && (
        <button
          onClick={onRematch}
          className="border-er-accent text-er-accent hover:bg-er-accent cursor-pointer rounded-full border px-5 py-2 font-mono text-[12px] tracking-[0.16em] uppercase transition-colors hover:text-black"
        >
          Run it again
        </button>
      )}
    </div>
  );
}
