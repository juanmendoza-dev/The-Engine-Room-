export type EngineType = "stockfish" | "maia" | "human" | "mixture";

export interface EngineConfig {
  type: EngineType;
  label: string;
  elo?: number; // stockfish only (UCI_Elo)
  ratingTier?: number; // maia only, or the mixture's internal Maia call (1100-1900)

  // ── mixture only ───────────────────────────────────────────────────────────
  // Four flat fields rather than a nested `mixture: {...}` object, so the same
  // `config` passes straight into both getStockfishLines() and evaluateMaia()
  // with no sub-config to construct. See engineMixture.ts for what each does.

  /** How many candidate lines to ask Stockfish for (`MultiPV`). */
  multiPv?: number;
  /** Weight on Stockfish's win probability. Conventionally pinned at 1 — see below. */
  alpha?: number;
  /** Weight on Maia's log-probability. The knob actually worth tuning. */
  beta?: number;
  /** 0 = argmax (deterministic), >0 = softmax sampling over the blended score. */
  temperature?: number;
}

// Why α is conventionally 1: α, β and temperature share a redundant degree of
// freedom. Scaling α and β both by k is identical to dividing T by k, because
// `score / T` is what gets exponentiated. So there are two effective free
// parameters, not three — the ratio α:β (which move wins as T → 0), and the
// score's scale relative to T (how sharp or flat the sampling is). Fixing α = 1
// and tuning β and T covers the whole space without three knobs that can
// silently cancel each other out.

export interface EngineMove {
  from: string;
  to: string;
  promotion?: string;
}
