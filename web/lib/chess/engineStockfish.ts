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

function parseUciMove(uci: string): EngineMove {
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
