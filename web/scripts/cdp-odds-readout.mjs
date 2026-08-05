// Drives the odds panel on /user-1v1 in a real browser: play a few moves, ask for
// the rollouts, wait out the ~30-60s of Maia self-play, and check what lands on
// screen. Everything else about this feature is arithmetic in a dev page; this is
// the only check that the button, the progress line, the numbers and the staleness
// rule actually work where a person would meet them.
//
// The last assertion is the interesting one. Odds describe one exact position, so
// moving a piece has to wipe them — a panel still showing percentages for the
// position before your move would be the most misleading state this page can
// reach. That's asserted here, not assumed.
//
// Opponent is Stockfish on purpose: it exercises resolveOppoBucket's rounding path
// (UCI_Elo 1320 -> the 1300 bucket) and replies in ~500ms instead of loading a
// second model. Maia still gets loaded — the rollouts need it.
//
// usage:
//   node scripts/cdp-odds-readout.mjs <url> <player-moves> <timeout-ms> [cdp-port]
//
// Chrome must already be running with --remote-debugging-port on that port, the
// target URL as a launch argument, and a tall --window-size — same three reasons
// as cdp-rating-readout.mjs (docs/deployment.md §4): Page.navigate can park on
// about:blank, `localhost` never 127.0.0.1 or the page never hydrates, and a short
// window makes two-rank drags start missing once the move log grows the page.

const [
  ,
  ,
  TARGET_URL = "http://localhost:3000/user-1v1",
  PLAYER_MOVES = "3",
  TIMEOUT_MS = "600000",
  PORT = "9222",
] = process.argv;

const WANT_MOVES = Number(PLAYER_MOVES);
const OPPONENT_LABEL = "Stockfish 1320";

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

const CANDIDATES = [
  "g1f3", "b1c3", "e2e4", "d2d4", "a2a3", "h2h3", "b2b3", "g2g3",
  "c2c3", "f2f3", "a3a4", "h3h4", "b3b4", "g3g4", "c3c4", "f3f4",
  "d1c2", "c1b2", "f1e2", "a1b1", "h1g1", "e1f2",
];

const plyExpr = `(() => {
  const h = [...document.querySelectorAll('h2')].find(e => /plies/i.test(e.textContent || ''));
  if (!h) return null;
  const m = /(\\d+)\\s+plies/i.exec(h.textContent);
  return m ? Number(m[1]) : null;
})()`;

/** The whole odds panel as one line, or null when it isn't rendered at all. */
const oddsExpr = `(() => {
  const h = [...document.querySelectorAll('h2')].find(e => /odds from here/i.test(e.textContent || ''));
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
// Chrome loaded the launch-arg URL before this socket existed, so reload with the
// listeners attached or an early console error goes unheard.
await cdp.send("Page.reload", { ignoreCache: false });

const deadline = Date.now() + Number(TIMEOUT_MS);
const results = [];
const check = (ok, label) => {
  results.push({ ok, label });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
};

function dumpConsole() {
  console.log("");
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

const bail = (msg) => {
  console.log(`FAIL  ${msg}`);
  dumpConsole();
  ws.close();
  process.exit(1);
};

// Squares are in the SSR HTML, so waiting for them proves nothing. Wait for React.
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
if (!hydrated) bail("page never hydrated (no React keys on the Start button)");
console.log("hydrated");

// Before the game starts there is no position to roll out, so there should be no
// panel at all — not a disabled one.
check((await cdp.evaluate(oddsExpr)) === null, "no odds panel before a game exists");

const picked = await cdp.evaluate(`(() => {
  const sel = [...document.querySelectorAll('select')].find(s =>
    [...s.options].some(o => o.value === ${JSON.stringify(OPPONENT_LABEL)}));
  if (!sel) return 'no select carrying that option';
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(sel, ${JSON.stringify(OPPONENT_LABEL)});
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return sel.value;
})()`);
if (picked !== OPPONENT_LABEL) bail(`could not select the opponent (got ${picked})`);

if (
  !(await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(e => /start game/i.test(e.textContent || ''));
    if (!b) return false;
    b.click();
    return true;
  })()`))
) {
  bail("no Start game button to click");
}
console.log(`started against ${picked}\n`);

async function drag(from, to) {
  // Both ends measured in ONE evaluate at one scroll position — measuring them
  // separately lands mousePressed ~48px off once the move log makes the page
  // scrollable, and the drag silently never starts.
  const c = await cdp.evaluate(`(() => {
    const f = document.querySelector('[data-square="${from}"]');
    const t = document.querySelector('[data-square="${to}"]');
    if (!f || !t) return null;
    const fr = f.getBoundingClientRect(), tr = t.getBoundingClientRect();
    return { fx: fr.left + fr.width / 2, fy: fr.top + fr.height / 2,
             tx: tr.left + tr.width / 2, ty: tr.top + tr.height / 2 };
  })()`);
  if (!c) return false;
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

const untried = [...CANDIDATES];

/** Plays one accepted move and waits for the engine's reply. */
async function playOneMove() {
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
  if (!landed) bail(`no candidate move was accepted at ply ${before}`);

  const until = Date.now() + 90000;
  while (Date.now() < until) {
    const err = await cdp.evaluate(errorExpr);
    if (err) bail(`the board reported an error: ${err}`);
    const ply = await cdp.evaluate(plyExpr);
    if (typeof ply === "number" && ply >= before + 2) return { landed, ply };
    await sleep(500);
  }
  bail("the engine never replied");
}

for (let move = 1; move <= WANT_MOVES; move++) {
  const { landed, ply } = await playOneMove();
  console.log(`move ${move}  ${landed}  ply ${ply}`);
}
console.log("");

const idlePanel = await cdp.evaluate(oddsExpr);
console.log(`idle panel: ${idlePanel}`);
check(/play it out/i.test(idlePanel ?? ""), "the panel offers to play the position out");
check(
  /~30s|in this tab/i.test(idlePanel ?? ""),
  "...and says up front that it costs real time in this tab",
);
check(
  !/\d+%/.test(idlePanel ?? ""),
  "no percentages on screen before anything has been rolled out",
);

const asked = await cdp.evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(e => /play it out/i.test(e.textContent || ''));
  if (!b || b.disabled) return false;
  b.click();
  return true;
})()`);
if (!asked) bail("the 'play it out' button was missing or disabled on the player's turn");
console.log("clicked play-it-out\n");

// Progress has to show up, or a minute of silence is indistinguishable from a hang.
let sawProgress = false;
let sawStop = false;
const runUntil = Math.min(deadline, Date.now() + 420000);
let finalPanel = null;
while (Date.now() < runUntil) {
  const panel = await cdp.evaluate(oddsExpr);
  if (panel && /settled/i.test(panel)) sawProgress = true;
  if (panel && /\bstop\b/i.test(panel)) sawStop = true;
  if (panel && /\bwin\b/i.test(panel) && /likely/i.test(panel)) {
    finalPanel = panel;
    break;
  }
  await sleep(1500);
}

check(sawProgress, "a progress line appears while it runs (settled / ply count)");
check(sawStop, "...with a way to stop it");
if (!finalPanel) bail("the odds never resolved into a result");

console.log("");
console.log("=== RESULT PANEL ===");
console.log(finalPanel);
console.log("");

const percentages = finalPanel.match(/\d+%/g) ?? [];
check(/win/i.test(finalPanel) && /draw/i.test(finalPanel) && /loss/i.test(finalPanel),
  "all three outcomes are reported, not just the win chance");
check(
  (finalPanel.match(/likely \d+%–\d+%/g) ?? []).length >= 3,
  "every one of the three carries its own interval — no bare number anywhere",
);
check(/30 games/i.test(finalPanel), "the sample size is on screen");
check(/Maia \d{4}.*vs \d{4}/i.test(finalPanel), "the two ratings it sampled at are named");
check(
  /not an engine evaluation/i.test(finalPanel),
  "it says what it is not — this is sampled human-ish play, not an eval",
);
console.log(`(percentages found: ${percentages.join(" ")})`);

// The staleness rule: one move must wipe numbers that described the old position.
await playOneMove();
await sleep(800);
const afterMove = await cdp.evaluate(oddsExpr);
console.log("");
console.log(`panel after moving: ${afterMove}`);
check(
  !/likely \d+%–\d+%/.test(afterMove ?? ""),
  "moving a piece clears the odds — they described a position that no longer exists",
);
check(
  /play it out/i.test(afterMove ?? ""),
  "...and the panel offers to run again rather than disappearing",
);

dumpConsole();

const clashed = cdp.events.some((e) => {
  const text =
    e.method === "Log.entryAdded"
      ? e.params.entry.text
      : (e.params?.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
  return /Session already started/i.test(text ?? "");
});
check(!clashed, 'no "Session already started" — rollouts and the game shared one ORT session');

console.log("");
const failed = results.filter((r) => !r.ok);
console.log(`=== ${failed.length === 0 ? "OK" : `PROBLEM (${failed.length} failed)`} ===`);
ws.close();
process.exit(failed.length === 0 ? 0 : 1);
