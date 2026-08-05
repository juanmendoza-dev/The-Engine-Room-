// Minimal CDP driver: navigate a headless Chrome to a URL, poll the page text
// until a marker appears, then dump the text plus any console errors.
// Zero dependencies - Node 22+ has global fetch and WebSocket.
//
// usage: node cdp-drive.js <url> <done-marker> <timeout-ms> [cdp-port]

const [, , TARGET_URL, DONE_MARKER = "done", TIMEOUT_MS = "90000", PORT = "9222"] =
  process.argv;

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
await cdp.send("Page.navigate", { url: TARGET_URL });

const deadline = Date.now() + Number(TIMEOUT_MS);
let text = "";
while (Date.now() < deadline) {
  await sleep(1000);
  try {
    const res = await cdp.send("Runtime.evaluate", {
      expression: "document.body ? document.body.innerText : ''",
      returnByValue: true,
    });
    text = res.result?.value ?? "";
  } catch {
    /* mid-navigation, try again */
  }
  if (text.includes(DONE_MARKER)) break;
}

console.log("=== PAGE TEXT ===");
console.log(text || "(empty)");

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
      e.params.args.map((a) => a.value ?? a.description ?? "").join(" ")
    );
  }
  if (e.method === "Log.entryAdded" && e.params.entry.level === "error") {
    sawProblem = true;
    console.log("LOG-ERROR:", e.params.entry.text);
  }
}
if (!sawProblem) console.log("(none)");

const ok = text.includes(DONE_MARKER);
console.log(`=== ${ok ? "MARKER FOUND" : "MARKER NOT FOUND (timed out)"} ===`);
ws.close();
process.exit(ok ? 0 : 1);
