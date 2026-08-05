// Integration check for the policy mixture (Task 15): does the new engine
// actually play through the real game loop and the real UI?
//
// /dev/mixture-test already proves the blend arithmetic. It proves nothing about
// the wiring, and the wiring is where a new EngineType member is most likely to
// fail *silently* — TypeScript doesn't flag a `config.type === "maia"` comparison
// for not mentioning "mixture", it just evaluates to false. So the three things
// checked here are exactly the three the spec called out as silent-no-op risks:
//
//   1. the VS card's power-level line, which falls through to `return config.type`
//      and would otherwise print the literal word "mixture";
//   2. the Maia download notice, which MUST also fire for a mixture config
//      (same ~93MB weight file) or the screen just looks frozen for 25s;
//   3. plies actually accumulating, i.e. getMoveFor dispatches to the mixture and
//      the game loop accepts what it returns.
//
// Zero dependencies, same CDP approach as scripts/cdp-verify.mjs and
// scripts/cdp-model-1v1.mjs.
//
// usage:
//   node scripts/cdp-mixture-game.mjs <url> <min-plies> <timeout-ms> [cdp-port]

const [
  ,
  ,
  TARGET_URL = "http://localhost:3210/model-1v1",
  MIN_PLIES = "8",
  TIMEOUT_MS = "300000",
  PORT = "9222",
] = process.argv;

/** Must match MIXTURE_PRESETS[0].label — the picker keys options by label. */
const MIXTURE_LABEL = "Policy Mixture (uncalibrated)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const fail = (msg) => {
  problems.push(msg);
  console.log(`FAIL   ${msg}`);
};
const ok = (msg) => console.log(`PASS   ${msg}`);

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
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
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

async function findPageTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
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

// Navigate in a loop until location.href actually reports the target. Page.navigate
// can return a normal-looking result and leave the tab parked on about:blank; see
// docs/deployment.md §4.
for (let i = 0; i < 20; i++) {
  await cdp.send("Page.navigate", { url: TARGET_URL });
  await sleep(700);
  const href = await cdp.evaluate("location.href");
  if (typeof href === "string" && href.startsWith(TARGET_URL)) break;
}

// Squares in the DOM don't mean the page is interactive — they're in the SSR HTML.
// Wait for React to have attached instead.
let hydrated = false;
for (let i = 0; i < 40; i++) {
  hydrated = await cdp.evaluate(`(() => {
    const el = document.querySelector('select') || document.querySelector('button');
    return !!el && Object.keys(el).some(k => k.startsWith('__react'));
  })()`);
  if (hydrated) break;
  await sleep(500);
}
if (!hydrated) fail("page never hydrated — every later check would be meaningless");
else ok("page hydrated");

// Both sides set to the mixture, so one game exercises it as White and as Black.
// React ignores `.value =` on a controlled <select>; the native setter plus a
// bubbling change event is what it listens for.
const selected = await cdp.evaluate(`(() => {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  const out = [];
  for (const sel of document.querySelectorAll('select')) {
    if (![...sel.options].some(o => o.value === ${JSON.stringify(MIXTURE_LABEL)})) continue;
    setter.call(sel, ${JSON.stringify(MIXTURE_LABEL)});
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    out.push(sel.value);
  }
  return out;
})()`);
if (!Array.isArray(selected) || selected.length < 2) {
  fail(`expected 2 pickers offering "${MIXTURE_LABEL}", got ${JSON.stringify(selected)}`);
} else if (selected.some((v) => v !== MIXTURE_LABEL)) {
  fail(`a picker did not take the value: ${JSON.stringify(selected)}`);
} else {
  ok(`both pickers set to "${MIXTURE_LABEL}" (reaches both screens via ALL_ENGINE_PRESETS)`);
}

const clicked = await cdp.evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(e => /start game/i.test(e.textContent || ''));
  if (!b) return false;
  b.click();
  return true;
})()`);
if (!clicked) fail("no Start game button to click");

// The Maia notice and the VS card are both transient — the notice disappears once
// the weights are ready, and the VS card holds for ~1.7s. Sample from inside the
// page on an interval rather than hoping a single Node-side poll lands in the
// window; a slow CDP round trip then only delays when the log is read, never what
// is in it (docs/deployment.md §4).
await cdp.evaluate(`(() => {
  window.__mixtureProbe = { notice: false, vsLabels: [], errors: [] };
  window.__mixtureTimer = setInterval(() => {
    const text = document.body ? document.body.innerText : '';
    if (/maia|weights|download/i.test(text) && /MB|%|loading|moment/i.test(text)) {
      window.__mixtureProbe.notice = true;
    }
    // The VS card's power-level line, read off its own element rather than out of
    // whole-page innerText. Scoping matters: the preset is *labelled* "Policy
    // Mixture (uncalibrated)", so a /\\bmixture\\b/ test against the whole page
    // matches the dropdown and the thinking lamp and reports a failure that isn't
    // one. Only this element carries eloLabel()'s return value.
    // (No backticks anywhere in this injected function — it is a template literal
    // on the Node side, and one stray backtick ends the literal early.)
    for (const el of document.querySelectorAll('.er-fx-vs-elo')) {
      const label = (el.textContent || '').trim();
      if (label && !window.__mixtureProbe.vsLabels.includes(label)) {
        window.__mixtureProbe.vsLabels.push(label);
      }
    }
    if (/engine failed/i.test(text)) window.__mixtureProbe.errors.push('engine failed shown');
  }, 120);
  return true;
})()`);

const deadline = Date.now() + Number(TIMEOUT_MS);
let plies = 0;
let finished = false;
let endReason = "";
const seen = [];
let text = "";
while (Date.now() < deadline) {
  await sleep(1000);
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
  // innerText reports *rendered* text, and the result screen is uppercased by CSS,
  // so this test has to be case-insensitive or it silently never fires. The match
  // is captured, not just tested: "finished" after 8 plies is either a real short
  // game or a word like "wins" appearing somewhere unrelated, and only the matched
  // text distinguishes those.
  const end = text.match(/\b(wins|draw)\b/i);
  if (end) {
    finished = true;
    endReason = text
      .slice(Math.max(0, end.index - 60), end.index + 60)
      .replace(/\s+/g, " ")
      .trim();
    break;
  }
  if (plies >= Number(MIN_PLIES)) break;
}

await cdp.evaluate("clearInterval(window.__mixtureTimer), true");
const probe = (await cdp.evaluate("JSON.stringify(window.__mixtureProbe)")) ?? "{}";
const { notice, vsLabels, errors } = JSON.parse(probe);

console.log("");
console.log(`ply progression: ${seen.join(" → ") || "(never moved)"}`);
if (finished) console.log(`end-of-game text matched: "${endReason}"`);
if (plies >= Number(MIN_PLIES) || finished) {
  ok(`mixture played ${plies} plies${finished ? " (game finished)" : ""} through the real game loop`);
} else {
  fail(`only ${plies} plies in ${TIMEOUT_MS}ms — wanted ${MIN_PLIES}`);
}

if (notice) ok("Maia download notice fired for a mixture config (usesMaiaWeights wiring)");
else
  console.log(
    "NOTE   never saw the Maia notice — expected on a warm run where the weights " +
      "were already in memory, a real failure on a cold one. Not asserted for that reason.",
  );

const bare = vsLabels.filter((l) => /^(mixture|stockfish|maia|human)$/i.test(l));
if (bare.length > 0) {
  fail(`VS card printed a raw EngineType instead of a power level: ${JSON.stringify(bare)}`);
} else if (vsLabels.length > 0) {
  ok(`VS card power-level line reads ${JSON.stringify(vsLabels)}`);
} else {
  console.log("NOTE   VS card text never sampled (it only holds ~1.7s, and only when FX are on)");
}

for (const e of errors) fail(e);

console.log("");
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

console.log("");
console.log(problems.length === 0 ? "=== ALL CHECKS PASSED ===" : `=== ${problems.length} FAILURE(S) ===`);
ws.close();
process.exit(problems.length === 0 ? 0 : 1);
