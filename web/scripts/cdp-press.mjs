// Drives the "press" route transition in a real headless Chrome, asserts what
// it does, and captures frames through it — the whole point of this change is
// something you can only judge by looking at it.
//
// Two passes per case, deliberately:
//
//   measureCase  installs an in-page rAF recorder, clicks, then reads the whole
//                timeline back at once and asserts against it.
//   captureCase  clicks and screenshots at wall-clock offsets, asserting
//                nothing.
//
// They're split because sampling the DOM from Node on a wall-clock delay is
// flaky: a CDP round trip against a busy headless Chrome can land several
// hundred ms after you asked for it, so a probe you scheduled for "140ms after
// the click" reads a press that has already finished and reports a broken
// feature that isn't broken. Cost an hour of chasing a phantom. The in-page
// recorder timestamps itself with performance.now(), so slow CDP only delays
// when you *read* the log, never what's in it. Screenshots still need wall-clock
// timing, hence the second pass, where being 200ms off just means a slightly
// different frame rather than a false failure.
//
// Clicks go through Input.dispatchMouseEvent, not element.click() — a synthetic
// click reports clientX/clientY of 0, which would put the ink bloom in the
// corner and quietly pass a broken coordinate path.
//
// usage: node scripts/cdp-press.mjs [base-url] [cdp-port] [out-dir]

import { mkdir, writeFile } from "node:fs/promises";

const [, , BASE = "http://localhost:3000", PORT = "9222", OUT = "press-frames"] = process.argv;

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
  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
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
await mkdir(OUT, { recursive: true });

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures.push(label);
};

async function shot(name) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  await writeFile(`${OUT}/${name}.png`, Buffer.from(data, "base64"));
}

async function goto(url, theme) {
  await cdp.send("Page.navigate", { url });
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const ready = await cdp.eval(
      `document.readyState === "complete" && !!document.querySelector('a[href="/"]')`,
    );
    if (ready) break;
    if (i === 39) throw new Error(`page never became ready: ${url}`);
  }
  await cdp.eval(
    theme === "dark"
      ? `document.documentElement.dataset.theme = "dark"`
      : `delete document.documentElement.dataset.theme`,
  );
  await sleep(1200); // let the page's own entry animations finish
}

/** Reads the target's centre and clicks it with real mouse events. */
async function pressLink(selector) {
  // Scroll FIRST and let it settle, then measure — measuring before the scroll
  // hands you a y outside the viewport and the click lands on nothing at all,
  // which reads as "the app ignored me" (deployment.md §4, the drag case).
  await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el) el.scrollIntoView({ block: "center", behavior: "instant" });
  })()`);
  await sleep(250);

  const box = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      vw: innerWidth,
      vh: innerHeight,
    };
  })()`);
  if (!box) throw new Error(`no element for ${selector}`);
  if (box.x < 0 || box.y < 0 || box.x > box.vw || box.y > box.vh) {
    throw new Error(
      `${selector} centre (${box.x},${box.y}) is outside the ${box.vw}x${box.vh} viewport — ` +
        `the click would hit nothing`,
    );
  }

  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", {
      type,
      x: box.x,
      y: box.y,
      button: "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: 1,
    });
  }
  return box;
}

/* Samples the press every frame into window.__pressLog. Survives the
   navigation because router.push is client-side — same JS context throughout. */
const RECORDER = `(() => {
  window.__pressLog = [];
  const t0 = performance.now();
  (function sample() {
    const press = document.querySelector(".er-press");
    if (press) {
      const bands = [...press.querySelectorAll(".er-press-band")];
      const ink = press.querySelector(".er-press-ink");
      window.__pressLog.push({
        t: Math.round(performance.now() - t0),
        phase: press.className.includes("--down") ? "down" : "up",
        bands: bands.length,
        covered: bands.filter((b) => new DOMMatrix(getComputedStyle(b).transform).d > 0.98).length,
        ink: ink ? { x: parseFloat(ink.style.left), y: parseFloat(ink.style.top) } : null,
        core: !!press.querySelector(".er-press-ink-core"),
        kicker: press.querySelector(".er-press-kicker")?.textContent ?? "",
        title: press.querySelector(".er-press-mask")?.textContent ?? "",
        stamped: !!document.querySelector("a.er-stamp"),
        path: location.pathname,
      });
    }
    requestAnimationFrame(sample);
  })();
  return true;
})()`;

async function measureCase({ name, theme, from, selector, expectPath, expectTitle }) {
  console.log(`\n--- ${name} ---`);
  await goto(BASE + from, theme);
  await cdp.eval(RECORDER);

  const click = await pressLink(selector);
  await sleep(2400); // comfortably past the whole ~1.2s press

  const log = await cdp.eval(`window.__pressLog`);
  const down = log.filter((s) => s.phase === "down");
  const up = log.filter((s) => s.phase === "up");
  const peak = Math.max(0, ...log.map((s) => s.covered));
  const inked = down.find((s) => s.ink);

  check(log.length > 0, `${name}: overlay ran (${log.length} frames sampled)`);
  check(down.length > 0, `${name}: platen closed (${down.length} frames)`);
  check(up.length > 0, `${name}: platen lifted (${up.length} frames)`);
  check(peak === 6, `${name}: platen reached full cover (${peak}/6 bands)`);
  check(
    !!inked && Math.abs(inked.ink.x - click.x) <= 1 && Math.abs(inked.ink.y - click.y) <= 1,
    `${name}: ink at click point (${inked?.ink?.x},${inked?.ink?.y} vs ${click.x},${click.y})`,
  );
  check(down.some((s) => s.core), `${name}: ink core present`);
  check(down.some((s) => s.stamped), `${name}: clicked control stamped down`);
  check(
    log.every((s) => s.title === expectTitle),
    `${name}: plate reads "${log[0]?.title}"`,
  );
  check(/^Plate \d\d · /.test(log[0]?.kicker ?? ""), `${name}: kicker reads "${log[0]?.kicker}"`);
  // The platen must still be down at the moment the route swaps — that's the
  // entire reason it exists.
  const swap = log.findIndex((s) => s.path === expectPath);
  check(swap >= 0 && log[swap].covered === 6, `${name}: route swapped while fully covered`);

  const after = await cdp.eval(
    // The hero h1 is three masked lines, so innerText arrives newline-separated.
    `({ path: location.pathname, up: !!document.querySelector(".er-press"),
        stamped: !!document.querySelector("a.er-stamp"),
        heading: (document.querySelector("h1")?.innerText ?? "").replace(/\\s+/g, " ").trim() })`,
  );
  check(after.path === expectPath, `${name}: landed on ${after.path}`);
  check(after.up === false, `${name}: overlay torn down`);
  check(after.stamped === false, `${name}: stamp released`);
  check(
    after.heading.toUpperCase().includes(expectTitle.toUpperCase()),
    `${name}: destination heading "${after.heading}"`,
  );
  return log;
}

/** Frames only — no assertions, so slow screenshots can't fail the run. */
async function captureCase({ name, theme, from, selector }) {
  await goto(BASE + from, theme);
  await pressLink(selector);
  for (const [wait, frame] of [
    [130, "1-ink"],
    [130, "2-ring"],
    [220, "3-plate"],
    [420, "4-lifting"],
    [900, "5-arrived"],
  ]) {
    await sleep(wait);
    await shot(`${name}-${frame}`);
  }
}

const CASES = [
  {
    name: "day-model",
    theme: "light",
    from: "/",
    selector: 'a[href="/model-1v1"]',
    expectPath: "/model-1v1",
    expectTitle: "Model 1v1",
  },
  {
    name: "night-history",
    theme: "dark",
    from: "/",
    selector: 'a[href="/history"]',
    expectPath: "/history",
    expectTitle: "History",
  },
  {
    name: "night-home",
    theme: "dark",
    from: "/user-1v1",
    selector: 'header a[href="/"]',
    expectPath: "/",
    expectTitle: "The Engine Room",
  },
];

await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false,
});

for (const c of CASES) {
  const log = await measureCase(c);
  const total = log.at(-1).t;
  console.log(`      timeline: ${total}ms end to end, ${log.length} frames`);
  await captureCase(c);
}

// Phone width: the plate title is clamp()ed display type, so it's the one thing
// here that can overflow a narrow viewport. "The Engine Room" is the longest.
console.log("\n--- phone ---");
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: 390,
  height: 844,
  deviceScaleFactor: 1,
  mobile: true,
});
await measureCase({
  name: "phone-user",
  theme: "light",
  from: "/",
  selector: 'a[href="/user-1v1"]',
  expectPath: "/user-1v1",
  expectTitle: "User 1v1",
});
await goto(BASE + "/history", "dark");
await pressLink('header a[href="/"]');
await sleep(430);
const narrow = await cdp.eval(`(() => {
  const mask = document.querySelector(".er-press-mask");
  if (!mask) return null;
  return { overflow: mask.scrollWidth > mask.clientWidth + 1, vw: innerWidth };
})()`);
await shot("phone-longest-title");
check(narrow && !narrow.overflow, `phone: longest plate title fits in ${narrow?.vw}px`);
await sleep(1400);

await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false,
});

// A link to the page you're already on must not run the press — there's nothing
// to cover, and a platen closing on the same page would look like a bug.
console.log("\n--- same-page link ---");
await goto(BASE + "/", "light");
await cdp.eval(RECORDER);
await pressLink('header a[href="/"]');
await sleep(400);
check((await cdp.eval(`window.__pressLog.length`)) === 0, "same-page: press did not run");
check((await cdp.eval(`location.pathname`)) === "/", "same-page: still on /");

// An impatient double-click must not stack a second platen or double-navigate.
console.log("\n--- double click ---");
await goto(BASE + "/", "light");
await cdp.eval(RECORDER);
await pressLink('a[href="/model-1v1"]');
await pressLink('a[href="/model-1v1"]');
await sleep(2400);
const dbl = await cdp.eval(`window.__pressLog`);
check(
  Math.max(...dbl.map((s) => s.bands)) === 6,
  `double: still one platen (max ${Math.max(...dbl.map((s) => s.bands))} bands)`,
);
check(dbl.at(-1).t < 2000, `double: one press, not two back to back (${dbl.at(-1).t}ms)`);
check(
  (await cdp.eval(`!!document.querySelector(".er-press")`)) === false,
  "double: overlay torn down",
);
check((await cdp.eval(`location.pathname`)) === "/model-1v1", "double: landed on /model-1v1");

// Reduced motion must skip the press entirely and still navigate.
console.log("\n--- reduced-motion ---");
await cdp.send("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-reduced-motion", value: "reduce" }],
});
await goto(BASE + "/", "light");
await pressLink('a[href="/user-1v1"]');
await sleep(120);
check((await cdp.eval(`!!document.querySelector(".er-press")`)) === false, "reduced-motion: no overlay");
await sleep(1400);
const rmPath = await cdp.eval(`location.pathname`);
check(rmPath === "/user-1v1", `reduced-motion: still navigated (${rmPath})`);
await cdp.send("Emulation.setEmulatedMedia", { features: [] });

console.log("\n=== CONSOLE ERRORS / EXCEPTIONS ===");
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

console.log(`\n=== ${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} FAILED`} ===`);
failures.forEach((f) => console.log("  -", f));
console.log(`frames in ${OUT}/`);
ws.close();
process.exit(failures.length === 0 && !sawProblem ? 0 : 1);
