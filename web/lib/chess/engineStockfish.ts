import type { EngineConfig, EngineMove } from "./types";

// Stockfish 18, "lite single-threaded" build. Three reasons for that flavour:
// it's ~7MB where the full build's wasm is 107MB (GitHub hard-rejects anything
// over 100MB, so the full one literally cannot live in this repo), it needs no
// SharedArrayBuffer and therefore no COOP/COEP headers, and the package's own
// README recommends it as the default. It's weaker than the full engine but
// still far above any human, and we cap it at UCI_Elo 2800 anyway.
//
// Emscripten resolves the .wasm relative to this .js, so the two files have to
// stay side by side in public/stockfish/.
const ENGINE_URL = "/stockfish/stockfish-18-lite-single.js";

// Per-move think time. Task 6's game loop should know this number when it
// picks its own inter-move delay: ~500ms x ~80 plies is roughly 40s a game.
export const MOVE_TIME_MS = 500;

// Generous, because it covers the first-load fetch of a 7MB wasm on a cold
// cache. It exists to turn a hung engine into an error the UI can show, not to
// enforce anything about speed.
const RESPONSE_TIMEOUT_MS = 60_000;

let worker: Worker | null = null;
let ready: Promise<void> | null = null;

// Every `option name ...` line the engine advertises during the `uci` handshake.
// Worth capturing because UCI engines silently ignore `setoption` for names they
// don't know - so a typo'd or unsupported option looks exactly like a working
// one. This is how verification code proves UCI_Elo is a real knob.
let advertisedOptions: string[] = [];

// One shared worker instance, so requests have to be serialized. Every reply is
// read by listening for the next line that matches — two overlapping `go`
// commands would resolve each other's promises and hand back the wrong move.
// The game loop already awaits each move, so this is belt-and-braces.
let queue: Promise<unknown> = Promise.resolve();

function getWorker(): Worker {
  if (typeof window === "undefined") {
    throw new Error("Stockfish runs in the browser only");
  }
  if (!worker) worker = new Worker(ENGINE_URL);
  return worker;
}

/**
 * Resolve with the first message line matching `matches`. `observe`, if given,
 * sees every line along the way - that's how callers get at the `info depth ...`
 * stream the engine emits while it searches.
 */
function nextLine(
  w: Worker,
  matches: (line: string) => boolean,
  observe?: (line: string) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Stockfish stopped responding after ${RESPONSE_TIMEOUT_MS}ms`));
    }, RESPONSE_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timer);
      w.removeEventListener("message", onMessage);
      w.removeEventListener("error", onError);
    }

    function onMessage(e: MessageEvent) {
      const line = typeof e.data === "string" ? e.data.trim() : "";
      observe?.(line);
      if (matches(line)) {
        cleanup();
        resolve(line);
      }
    }

    function onError() {
      cleanup();
      reject(new Error(`Stockfish failed to load from ${ENGINE_URL}`));
    }

    w.addEventListener("message", onMessage);
    w.addEventListener("error", onError);
  });
}

function initEngine(): Promise<void> {
  if (ready) return ready;

  const w = getWorker();
  ready = (async () => {
    advertisedOptions = [];
    w.postMessage("uci");
    await nextLine(
      w,
      (line) => line === "uciok",
      (line) => {
        if (line.startsWith("option name")) advertisedOptions.push(line);
      }
    );
  })();

  // Don't cache a failed handshake forever - let the next caller try again.
  ready.catch(() => {
    ready = null;
  });

  return ready;
}

/**
 * The `option name ...` lines from the UCI handshake, e.g.
 * `option name UCI_Elo type spin default 1320 min 1320 max 3190`.
 * Used by verification code to confirm the options we set actually exist on this
 * build - an unknown `setoption` name is dropped without any error.
 */
export async function getAdvertisedOptions(): Promise<string[]> {
  await initEngine();
  return [...advertisedOptions];
}

/** `e7e8q` -> `{ from: "e7", to: "e8", promotion: "q" }`. Exported for engineMixture.ts. */
export function parseUciMove(uci: string): EngineMove {
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci.slice(4, 5) : undefined,
  };
}

/**
 * `onInfo` receives each `info ...` line emitted during the search. Optional and
 * unused by the game loop - it exists so verification code can read the actual
 * search depth, which is the only direct evidence that the engine searched at
 * all. Wall-clock time isn't: a wrapper that slept for `movetime` and returned a
 * random legal move would look identical from the outside.
 */
export async function getStockfishMove(
  fen: string,
  config: EngineConfig,
  onInfo?: (line: string) => void
): Promise<EngineMove> {
  const run = queue.then(async () => {
    const w = getWorker();
    await initEngine();

    w.postMessage("ucinewgame");
    w.postMessage("setoption name UCI_LimitStrength value true");
    w.postMessage(`setoption name UCI_Elo value ${config.elo ?? 1500}`);
    // Explicit every call, even though 1 is the default: getStockfishLines sets
    // MultiPV higher on the *same* engine process, and a UCI option persists
    // until something changes it back. Without this line, a plain Stockfish
    // config sharing a board with a mixture config would silently inherit
    // whatever MultiPV the mixture last asked for.
    w.postMessage("setoption name MultiPV value 1");
    w.postMessage(`position fen ${fen}`);

    // isready/readyok before `go`. Not because `go` could overtake the setoptions
    // above - a single-threaded UCI engine reads stdin in order, so it can't. It's
    // here because readyok is the protocol's defined "done processing" signal,
    // because `ucinewgame` triggers a state reset the UCI spec says may be slow
    // and should be waited on, and because it stays correct on engine builds we
    // haven't tested. One round-trip against a 500ms search.
    w.postMessage("isready");
    await nextLine(w, (line) => line === "readyok");

    w.postMessage(`go movetime ${MOVE_TIME_MS}`);
    const line = await nextLine(
      w,
      (l) => l.startsWith("bestmove"),
      onInfo && ((l) => {
        if (l.startsWith("info")) onInfo(l);
      })
    );

    // "bestmove e2e4 ponder e7e5", or "bestmove (none)" in a dead position.
    const uci = line.split(/\s+/)[1];
    if (!uci || uci === "(none)") {
      throw new Error(`Stockfish returned no move: "${line}"`);
    }
    return parseUciMove(uci);
  });

  // Keep the chain alive after a rejection, otherwise one failed move poisons
  // every later call.
  queue = run.catch(() => {});
  return run;
}

// ── MultiPV: N scored candidate lines instead of one bestmove ─────────────────
// Added for the policy mixture (engineMixture.ts), which needs a shortlist of
// moves *with evaluations* to blend against Maia's policy. Nothing else uses it.

/** One `multipv` line from a MultiPV search. `cp` and `mate` are mutually exclusive. */
export interface StockfishLine {
  /** 1-based rank Stockfish assigned this line; 1 is its best. */
  multipv: number;
  /** First move of the principal variation, UCI. The only part the mixture reads. */
  uci: string;
  /** Centipawns, **relative to the side to move** per UCI. Undefined on a mate score. */
  cp?: number;
  /** Moves to mate, signed: positive means the side to move is mating. */
  mate?: number;
  /** `depth` this line was last reported at. See the equal-depth caveat below. */
  depth: number | null;
}

export interface StockfishLines {
  /** Parsed lines, best first. Fewer than `multiPv` entries if the position has fewer legal moves. */
  lines: StockfishLine[];
  /**
   * The raw `bestmove` token, or null on `bestmove (none)`.
   *
   * Returned alongside the lines rather than discarded because "does the
   * `multipv 1` line agree with the `bestmove` token" is exactly the question
   * the UCI_LimitStrength × MultiPV interaction raises, and there's no way to
   * ask it afterwards from a separate call — a second search is a second roll of
   * the timing dice.
   */
  bestmove: string | null;
}

// info depth 12 seldepth 15 multipv 2 score cp 34 nodes 1234 … pv e2e4 e7e5 g1f3
//
// `\bpv` cannot match inside `multipv`: there's no word boundary between the "i"
// and the "p", so the two tokens don't collide even though one contains the other.
const MULTIPV_RE = /\bmultipv (\d+)\b.*?\bscore (?:cp (-?\d+)|mate (-?\d+))\b.*?\bpv (\S+)/;

/**
 * Aspiration-window re-searches tag a score `lowerbound`/`upperbound`, meaning
 * "the true value is at least/at most this" — provisional, not a finished eval.
 * Skipping those lines is cheap insurance; `bestmove` only arrives once the depth
 * settles, so a final unbounded line for each index follows.
 */
const BOUNDED_RE = /\b(?:lowerbound|upperbound)\b/;

/**
 * Run one search and return its top `multiPv` lines, each with an evaluation.
 *
 * Two deltas from `getStockfishMove`, both deliberate:
 *
 *  - **A missing `elo` means UNCAPPED here**, where `getStockfishMove` defaults
 *    to 1500. The mixture wants honest per-line evaluations so its own α/β/T does
 *    the strength shaping; a strength-limited search would make calibration chase
 *    a target tangled up with whatever the limiter does internally. Safe as a
 *    difference in default because every existing Stockfish preset sets an
 *    explicit `elo`. A mixture config that gets an `elo` by mistake gets capped
 *    again silently — hence the dev warning in engineMixture.ts.
 *  - **`MultiPV` is set to `multiPv`**, and `getStockfishMove` now resets it to 1
 *    on every call so the two can't leak state into each other.
 *
 * **The N lines are not guaranteed to be equally deep.** UCI has no per-line
 * "finished" signal — completion is only announced for the search as a whole, via
 * `bestmove`. This keeps the last line seen per index, which is the deepest one
 * reported for it, but a line Stockfish stopped revisiting can be shallower than
 * its siblings. `depth` is returned per line so a caller can see that rather than
 * assume otherwise.
 *
 * **MultiPV costs real depth at a fixed movetime — measured, ~5-6 plies.** The
 * spec listed this as unknown; `/dev/mixture-test` section B answers it. At the
 * same 500ms budget, `MultiPV=1` vs `MultiPV=8`: depth 17 → 12 on an open Italian
 * position, 20 → 14 on a closed middlegame. So a wider shortlist is not free — it
 * buys candidates by making every candidate's evaluation shallower, and a shallower
 * cp is a less trustworthy cp with nothing in the output to flag it as such. Worth
 * weighing when calibration picks a `multiPv`.
 *
 * **`UCI_LimitStrength` does NOT perturb the reported per-line evals.** Also
 * flagged as unverified in the spec, also now measured in the same place: at
 * `MultiPV=5` on one position, uncapped and `UCI_Elo 1320` returned *byte-identical*
 * cp values across all five lines (`d2d4:38 f1b5:37 b1c3:21 f1c4:20 f1e2:-3`), while
 * the `bestmove` token moved from `d2d4` to `a2a4`. So limit-strength picks a
 * different line to *play*; it doesn't lie about what the lines are worth. One
 * position, so not proof for every position — but it's direct evidence where the
 * spec had an inference from an indirect data point, and it means the mixture's
 * choice to skip limit-strength is a clean-calibration decision rather than a
 * workaround for dishonest numbers.
 *
 * Chains through the same `queue` as `getStockfishMove` — not a private one.
 * That queue is what stops two live `go` commands on one worker from resolving
 * each other's promises.
 */
export async function getStockfishLines(
  fen: string,
  config: EngineConfig,
  multiPv: number,
  onInfo?: (line: string) => void
): Promise<StockfishLines> {
  const run = queue.then(async () => {
    const w = getWorker();
    await initEngine();

    w.postMessage("ucinewgame");
    if (config.elo !== undefined) {
      w.postMessage("setoption name UCI_LimitStrength value true");
      w.postMessage(`setoption name UCI_Elo value ${config.elo}`);
    } else {
      w.postMessage("setoption name UCI_LimitStrength value false");
    }
    w.postMessage(`setoption name MultiPV value ${multiPv}`);
    w.postMessage(`position fen ${fen}`);

    w.postMessage("isready");
    await nextLine(w, (line) => line === "readyok");

    w.postMessage(`go movetime ${MOVE_TIME_MS}`);

    const lines = new Map<number, StockfishLine>();
    const finished = await nextLine(
      w,
      (l) => l.startsWith("bestmove"),
      (l) => {
        if (!l.startsWith("info")) return;
        onInfo?.(l);
        if (BOUNDED_RE.test(l)) return;

        const parsed = MULTIPV_RE.exec(l);
        if (!parsed) return;
        const [, index, cp, mate, uci] = parsed;
        const depth = /\bdepth (\d+)/.exec(l);

        lines.set(Number(index), {
          multipv: Number(index),
          uci,
          cp: cp === undefined ? undefined : Number(cp),
          mate: mate === undefined ? undefined : Number(mate),
          depth: depth ? Number(depth[1]) : null,
        });
      }
    );

    // "bestmove e2e4 ponder e7e5", or "bestmove (none)" in a dead position. Not
    // thrown on here the way getStockfishMove does: a caller asking for lines can
    // legitimately want to see "no lines, no bestmove" rather than an exception.
    const token = finished.split(/\s+/)[1];

    return {
      lines: [...lines.values()].sort((a, b) => a.multipv - b.multipv),
      bestmove: !token || token === "(none)" ? null : token,
    };
  });

  queue = run.catch(() => {});
  return run;
}
