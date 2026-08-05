// Plays a real game on /user-1v1 in headless Chrome and watches the rating
// readout, because the estimator's whole point is that it runs live off the
// player's own drags — every other check on it is arithmetic in a dev page.
//
// Opponent is Maia on purpose: it shares the one ORT session with the estimator's
// nine forward passes per ply, which is the collision that would surface as
// "Engine failed" on the board. A Stockfish opponent would never exercise it.
//
// usage:
//   node scripts/cdp-rating-readout.mjs <url> <player-moves> <timeout-ms> [cdp-port]
//
// Chrome must already be running with --remote-debugging-port on that port, the
// target URL as a launch argument, and a tall --window-size. Three reasons,
// all from docs/deployment.md §4:
//   - Page.navigate can leave the tab parked on about:blank; a launch-arg URL
//     can't.
//   - `localhost`, never 127.0.0.1 — Next 16 treats the IP literal as
//     cross-origin, blocks its own /_next dev resources, and the page renders
//     perfectly and never hydrates.
//   - a tall window means the move log can't grow the page into a scrollable one,
//     which is what makes two-rank drags start missing by ~48px halfway through
//     a game.

const [
  ,
  ,
  TARGET_URL = "http://localhost:3000/user-1v1",
  PLAYER_MOVES = "11",
  TIMEOUT_MS = "420000",
  PORT = "9222",
] = process.argv;

const WANT_MOVES = Number(PLAYER_MOVES);
const OPPONENT_LABEL = "Maia 1500";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const res = await this.send("Runtime.evaluate", { expression, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? "evaluate threw");
    }
    return res.result?.value;
  }
}

async function findPageTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
      const onTarget = pages.find((t) => t.url.startsWith(TARGET_URL));
      if (onTarget || pages.length) return onTarget ?? pages[0];
    } catch {
      /* browser not up yet */
    }
    await sleep(500);
  }
  throw new Error("no CDP page target — is Chrome running with --remote-debugging-port?");
}

// Quiet, mostly-always-legal White moves. The driver has no board model, so it
// tries these in order and keeps whichever chess.js accepts — which is also a
// free check that illegal drags are rejected rather than breaking anything.
const CANDIDATES = [
  "g1f3", "b1c3", "e2e4", "d2d4", "a2a3", "h2h3", "b2b3", "g2g3",
  "c2c3", "f2f3", "a3a4", "h3h4", "b3b4", "g3g4", "c3c4", "f3f4",
  "d1c2", "c1b2", "f1e2", "a1b1", "h1g1", "e1f2", "d4d5", "e4e5",
  "c2c4", "d2d3", "f2f4", "b1a3", "g1h3", "a4a5", "h4h5",
];

const plyExpr = `(() => {
  const h = [...document.querySelectorAll('h2')].find(e => /plies/i.test(e.textContent || ''));
  if (!h) return null;
  const m = /(\\d+)\\s+plies/i.exec(h.textContent);
  return m ? Number(m[1]) : null;
})()`;

const readoutExpr = `(() => {
  const h = [...document.querySelectorAll('h2')].find(e => /rating read/i.test(e.textContent || ''));
  if (!h || !h.parentElement) return null;
  return h.parentElement.innerText.replace(/\\s*\\n+\\s*/g, ' | ').trim();
})()`;

const errorExpr = `(() => {
  const el = document.querySelector('[role="alert"]');
  return el ? el.innerText.replace(/\\s*\\n+\\s*/g, ' ').trim() : null;
})()`;

const target = await findPageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", () => reject(new Error("CDP websocket failed")), { once: true });
});

const cdp = new Cdp(ws);
await cdp.send("Runtime.enable");
await cdp.send("Log.enable");
await cdp.send("Page.enable");
// Chrome loaded the launch-arg URL before this socket existed, so anything logged
// during that load has already gone unheard. Reload now that we're listening.
await cdp.send("Page.reload", { ignoreCache: false });

const deadline = Date.now() + Number(TIMEOUT_MS);
const fail = (msg) => {
  console.log(`FAIL  ${msg}`);
  dumpConsole();
  ws.close();
  process.exit(1);
};

// Squares are in the SSR HTML, so their presence proves nothing about whether the
// page will respond to a click. Wait for React to have attached to its own tree.
let hydrated = false;
while (Date.now() < deadline) {
  await sleep(500);
  try {
    hydrated = await cdp.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(e => /start game/i.test(e.textContent || ''));
      return !!b && Object.keys(b).some(k => k.startsWith('__react'));
    })()`);
  } catch {
    /* mid-navigation */
  }
  if (hydrated) break;
}
if (!hydrated) fail("page never hydrated (no React keys on the Start button)");
console.log("hydrated");

// React ignores a plain `.value =` on a controlled select — it reads the value off
// its own state, so the assignment is reverted on the next render. The native
// setter plus a bubbling change event is what actually drives onChange.
const picked = await cdp.evaluate(`(() => {
  const sel = [...document.querySelectorAll('select')].find(s =>
    [...s.options].some(o => o.value === ${JSON.stringify(OPPONENT_LABEL)}));
  if (!sel) return 'no select carrying that option';
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(sel, ${JSON.stringify(OPPONENT_LABEL)});
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return sel.value;
})()`);
if (picked !== OPPONENT_LABEL) fail(`could not select the opponent (got ${picked})`);
console.log(`opponent: ${picked}`);

const clicked = await cdp.evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(e => /start game/i.test(e.textContent || ''));
  if (!b) return false;
  b.click();
  return true;
})()`);
if (!clicked) fail("no Start game button to click");
console.log("started\n");

async function centres(from, to) {
  // BOTH ends measured in one evaluate, at one scroll position. Measuring them
  // separately — worse, with a scrollIntoView between — reads `from` at one
  // offset and `to` at another, so mousePressed lands ~48px off, on an empty
  // square, and the drag silently never starts. Reads as the app rejecting a
  // legal move.
  return cdp.evaluate(`(() => {
    const f = document.querySelector('[data-square="${from}"]');
    const t = document.querySelector('[data-square="${to}"]');
    if (!f || !t) return null;
    const fr = f.getBoundingClientRect(), tr = t.getBoundingClientRect();
    return { fx: fr.left + fr.width / 2, fy: fr.top + fr.height / 2,
             tx: tr.left + tr.width / 2, ty: tr.top + tr.height / 2 };
  })()`);
}

async function drag(from, to) {
  const c = await centres(from, to);
  if (!c) return false;
  // react-chessboard v5 drags through dnd-kit's PointerSensor (1px activation),
  // which accepts synthesised mouse events. A few interpolated moves are needed —
  // press-then-release at the destination doesn't trip the sensor.
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: c.fx, y: c.fy, button: "left", clickCount: 1,
  });
  for (let i = 1; i <= 8; i++) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: c.fx + ((c.tx - c.fx) * i) / 8,
      y: c.fy + ((c.ty - c.fy) * i) / 8,
      button: "left",
    });
  }
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: c.tx, y: c.ty, button: "left", clickCount: 1,
  });
  return true;
}

async function waitForPly(atLeast, budgetMs) {
  const until = Date.now() + budgetMs;
  while (Date.now() < until) {
    const err = await cdp.evaluate(errorExpr);
    if (err) return { ply: null, error: err };
    const ply = await cdp.evaluate(plyExpr);
    if (typeof ply === "number" && ply >= atLeast) return { ply, error: null };
    await sleep(500);
  }
  return { ply: await cdp.evaluate(plyExpr), error: null, timedOut: true };
}

const played = [];
const untried = [...CANDIDATES];
let readout = null;

for (let move = 1; move <= WANT_MOVES; move++) {
  if (Date.now() > deadline) {
    console.log(`\nNOTE  out of time after ${played.length} player moves`);
    break;
  }

  const before = await cdp.evaluate(plyExpr);
  let landed = null;

  for (let i = 0; i < untried.length; i++) {
    const uci = untried[i];
    if (!(await drag(uci.slice(0, 2), uci.slice(2, 4)))) continue;
    await sleep(400);
    const now = await cdp.evaluate(plyExpr);
    if (typeof now === "number" && now > before) {
      landed = uci;
      untried.splice(i, 1);
      break;
    }
  }

  if (!landed) fail(`no candidate move was accepted at ply ${before}`);
  played.push(landed);

  // The engine's reply. Move 1 pays Maia's ~93MB cold load, so it gets a much
  // larger budget than the rest.
  const budget = move === 1 ? Math.min(300000, deadline - Date.now()) : 60000;
  const { ply, error, timedOut } = await waitForPly(before + 2, budget);
  if (error) fail(`the board reported an error: ${error}`);

  readout = await cdp.evaluate(readoutExpr);
  console.log(
    `move ${String(move).padStart(2)}  ${landed}  ply ${ply ?? "?"}` +
      `${timedOut ? "  (reply timed out)" : ""}  |  ${readout ?? "(no readout)"}`,
  );
  if (timedOut) fail("the engine never replied");
}

console.log("");
console.log("=== FINAL READOUT ===");
console.log(readout ?? "(none)");
console.log("");

function dumpConsole() {
  console.log("=== CONSOLE ERRORS / EXCEPTIONS ===");
  let saw = false;
  for (const e of cdp.events) {
    if (e.method === "Runtime.exceptionThrown") {
      saw = true;
      const d = e.params.exceptionDetails;
      console.log("EXCEPTION:", d?.exception?.description ?? d?.text ?? JSON.stringify(d));
    }
    if (e.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(e.params.type)) {
      saw = true;
      console.log(
        e.params.type.toUpperCase() + ":",
        e.params.args.map((a) => a.value ?? a.description ?? "").join(" "),
      );
    }
    if (e.method === "Log.entryAdded" && e.params.entry.level === "error") {
      saw = true;
      console.log("LOG-ERROR:", e.params.entry.text);
    }
  }
  if (!saw) console.log("(none)");
}

dumpConsole();

// The two failures that would matter most, called out rather than left in the dump.
const transcript = cdp.events
  .filter((e) => e.method === "Runtime.consoleAPICalled" || e.method === "Log.entryAdded")
  .map((e) =>
    e.method === "Log.entryAdded"
      ? e.params.entry.text
      : e.params.args.map((a) => a.value ?? a.description ?? "").join(" "),
  )
  .join("\n");

const sessionClash = /Session already started/i.test(transcript);
const skippedPlies = (transcript.match(/Rating estimate skipped/g) ?? []).length;

console.log("=== VERDICT ===");
console.log(`${played.length >= WANT_MOVES ? "PASS" : "FAIL"}  played ${played.length}/${WANT_MOVES} moves: ${played.join(" ")}`);
console.log(`${sessionClash ? "FAIL" : "PASS"}  no "Session already started" from overlapping ORT runs`);
console.log(`${skippedPlies === 0 ? "PASS" : "NOTE"}  ${skippedPlies} plies skipped by the estimator`);

const named = /Plays most like a\s*\|?\s*(\d{4})/.test(readout ?? "");
const banded = /likely\s*\d{4}\s*[–-]\s*\d{4}/.test(readout ?? "");
const holding = /Reading your moves|Loading the move model/i.test(readout ?? "");

if (named) {
  console.log(`PASS  readout names a bucket`);
  console.log(`${banded ? "PASS" : "FAIL"}  ...and never without its interval beside it`);
} else {
  console.log(`NOTE  gate still closed after ${played.length} moves — readout is holding: ${holding ? "yes" : "NO, and it should be"}`);
}

const ok = played.length >= WANT_MOVES && !sessionClash && (named ? banded : holding);
console.log(`=== ${ok ? "OK" : "PROBLEM"} ===`);
ws.close();
process.exit(ok ? 0 : 1);
