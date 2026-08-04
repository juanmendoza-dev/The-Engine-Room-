// Drives the Model 1v1 page in headless Chrome: navigates, clicks "Start game",
// then watches the ply counter climb until the game ends (or a ply floor is hit).
//
// Same zero-dependency CDP approach as scripts/cdp-verify.mjs — that one only
// polls page text, and this page needs a click to do anything. Kept separate
// rather than adding a click hook to that script, since it belongs to Task 2.
//
// usage:
//   node scripts/cdp-model-1v1.mjs <url> <min-plies> <timeout-ms> [cdp-port]

const [
  ,
  ,
  // 127.0.0.1, not localhost: this Chrome silently refuses to navigate to
  // http://localhost:3000 and sits on about:blank with no error anywhere — the
  // click then "fails" for what looks like a UI reason. The IPv4 literal works.
  TARGET_URL = "http://127.0.0.1:3000/model-1v1",
  MIN_PLIES = "8",
  TIMEOUT_MS = "180000",
  PORT = "9222",
] = process.argv;

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
    return res.result?.value;
  }
}

// Prefer a tab already showing the target URL. Chrome accumulates tabs across
// runs, and blindly taking the first `page` target means you can end up polling
// a stale about:blank forever while the real page sits in tab two.
async function findPageTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
      const onTarget = pages.find((t) => t.url.startsWith(TARGET_URL));
      if (onTarget || pages.length) {
        if (pages.length > 1) {
          console.log(`note: ${pages.length} page targets open; using ${onTarget ? "the one already on the target URL" : "the first"}`);
        }
        return onTarget ?? pages[0];
      }
    } catch {
      /* browser not up yet */
    }
    await sleep(500);
  }
  throw new Error("no CDP page target - is Chrome running with --remote-debugging-port?");
}

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
await cdp.send("Page.navigate", { url: TARGET_URL });

// Confirm the navigation actually landed before blaming the UI. Page.navigate can
// return a perfectly normal-looking result and leave the tab on about:blank (seen
// with a `localhost` URL, and when Chrome's network service restarts mid-run).
let landed = false;
for (let i = 0; i < 20; i++) {
  await sleep(500);
  const href = await cdp.evaluate("location.href");
  if (typeof href === "string" && href.startsWith(TARGET_URL)) {
    landed = true;
    break;
  }
}
if (!landed) {
  console.log(`NAVIGATION FAILED — tab never reached ${TARGET_URL}`);
  console.log(`current url: ${await cdp.evaluate("location.href")}`);
  ws.close();
  process.exit(1);
}

// Wait for hydration — the button is inert until React attaches its handler.
let clicked = false;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  clicked = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find(el => /start game|run it again/i.test(el.textContent || ''));
    if (!b || b.disabled) return false;
    b.click();
    return true;
  })()`);
  if (clicked) break;
}
console.log(clicked ? "clicked Start game" : "COULD NOT CLICK Start game");

const deadline = Date.now() + Number(TIMEOUT_MS);
let plies = 0;
let text = "";
let finished = false;
const seen = [];

while (Date.now() < deadline) {
  await sleep(1500);
  try {
    text = (await cdp.evaluate("document.body ? document.body.innerText : ''")) ?? "";
  } catch {
    continue; // mid-navigation
  }

  const m = text.match(/Moves\s*·\s*(\d+)\s*plies/i);
  const next = m ? Number(m[1]) : 0;
  if (next !== plies) {
    plies = next;
    seen.push(plies);
  }

  // Result screen renders one of these once chess.js says the game is over.
  // Case-insensitive on purpose: ResultScreen's heading is Tailwind `uppercase`,
  // and innerText reports *rendered* text, so this actually arrives as
  // "STOCKFISH 2800 WINS". A case-sensitive test here silently never fires and
  // the run just falls out via the MIN_PLIES exit looking like a pass.
  if (/\bwins\b|\bdraw\b/i.test(text)) {
    finished = true;
    break;
  }
  if (plies >= Number(MIN_PLIES)) break;
}

console.log(`ply progression: ${seen.join(" → ") || "(never moved)"}`);
console.log(`plies reached: ${plies}${finished ? " (game finished)" : ""}`);

const moveLog = text.match(/Moves[\s\S]{0,400}/)?.[0] ?? "";
console.log("=== MOVE LOG EXCERPT ===");
console.log(moveLog.trim() || "(none)");

if (finished) {
  const summary = text.match(/.*(wins|draw).*/i)?.[0];
  console.log("=== RESULT ===");
  console.log(summary?.trim() ?? "(unparsed)");
}

console.log("=== CONSOLE ERRORS / EXCEPTIONS ===");
let sawProblem = false;
for (const e of cdp.events) {
  if (e.method === "Runtime.exceptionThrown") {
    sawProblem = true;
    const d = e.params.exceptionDetails;
    console.log("EXCEPTION:", d?.exception?.description ?? d?.text ?? JSON.stringify(d));
  }
  if (e.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(e.params.type)) {
    sawProblem = true;
    console.log(
      e.params.type.toUpperCase() + ":",
      e.params.args.map((a) => a.value ?? a.description ?? "").join(" "),
    );
  }
  if (e.method === "Log.entryAdded" && e.params.entry.level === "error") {
    sawProblem = true;
    console.log("LOG-ERROR:", e.params.entry.text);
  }
}
if (!sawProblem) console.log("(none)");

const ok = clicked && plies >= Number(MIN_PLIES);
console.log(`=== ${ok ? "PASS" : "FAIL"} ===`);
ws.close();
process.exit(ok ? 0 : 1);
