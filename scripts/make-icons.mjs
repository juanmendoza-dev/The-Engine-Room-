// Rasterizes the ER monogram into the two raster icons Next can't derive from
// icon.svg: app/favicon.ico (legacy /favicon.ico + browsers without SVG icons)
// and app/apple-icon.png (iOS home screen). Geometry mirrors BrandMark.tsx.
//
//   node scripts/make-icons.mjs            # writes into app/
//   node scripts/make-icons.mjs <out-dir>
//
// Needs Chrome on disk (path below) and nothing else — no npm dependencies, no
// image library. Only rerun it when the mark's geometry changes; the outputs are
// committed.
//
// Both raster cuts sit on an OPAQUE bone plate rather than transparency: an ink
// monogram on transparent disappears entirely on a dark tab strip, and a raster
// icon can't carry a prefers-color-scheme rule the way icon.svg does.
//
// Pixels come off a canvas as raw RGBA and the PNG is encoded here rather than
// using Page.captureScreenshot, because Chrome's PNG encoder drops to RGB when
// every pixel is opaque and Next's ICO decoder rejects a non-RGBA payload
// ("The PNG is not in RGBA format!" -> build failure).
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const OUT_DIR = process.argv[2] ?? join(import.meta.dirname, "..", "app");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BONE = "#f2f0ea";
const INK = "#16151a";
const RED = "#e0331f";

const E = "M0 0H74V20H26V40H66V60H26V80H74V100H0Z";
const R = "M0 0H78V62H52L82 100H48L26 66V100H0ZM26 20H56V42H26Z";

// bare cut: cap 13 -> scale .13, letters at (0.5, 3.6), R advance 82*.13 = 10.66
const bare = `
  <g fill="${INK}" fill-rule="evenodd">
    <path d="${E}" transform="translate(0.5 3.6) scale(0.13)"/>
    <path d="${R}" transform="translate(11.16 3.6) scale(0.13)"/>
  </g>
  <rect fill="${RED}" x="20.4" y="19.4" width="3.1" height="3.1"/>`;

// plate cut: cap 9.5 -> scale .095, letters at (4.21, 7.25), R at 4.21+82*.095
const plate = `
  <rect x="1.5" y="1.5" width="21" height="21" fill="none" stroke="${INK}" stroke-width="1.5"/>
  <g fill="${INK}" fill-rule="evenodd">
    <path d="${E}" transform="translate(4.21 7.25) scale(0.095)"/>
    <path d="${R}" transform="translate(12 7.25) scale(0.095)"/>
  </g>
  <rect fill="${RED}" x="18" y="18" width="2.6" height="2.6"/>`;

const JOBS = [
  // 32px favicon: bare cut, full bleed — every pixel counts at that size.
  { name: "favicon.ico", px: 32, body: bare, inset: 0 },
  // 180px apple icon: plate cut, inset 15% so iOS's rounded mask can't clip the frame.
  { name: "apple-icon.png", px: 180, body: plate, inset: 0.15 },
];

/* --- PNG encoder (raw RGBA -> 8-bit RGBA PNG) ----------------------------- */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // 10-12: deflate / adaptive filtering / no interlace, all zero already.

  // One filter byte (0 = None) per scanline, then the row's raw bytes.
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  // .copy() rather than Buffer.from(rgba.buffer, …): Node pools small
  // allocations, so the source Buffer's byteOffset is not necessarily 0 and
  // indexing its raw ArrayBuffer would silently read the wrong pixels.
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** ICO container wrapping a single PNG — valid and universally supported. */
function icoWrap(png, px) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image
  const entry = Buffer.alloc(16);
  entry.writeUInt8(px === 256 ? 0 : px, 0);
  entry.writeUInt8(px === 256 ? 0 : px, 1);
  entry.writeUInt8(0, 2); // palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12); // offset past header + entry
  return Buffer.concat([header, entry, png]);
}

/* --- rasterize via canvas ------------------------------------------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chromeProfile = mkdtempSync(join(tmpdir(), "icoprof-"));
const PORT = 9520;
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${chromeProfile}`,
  "--window-size=400,400", "--no-first-run", "--no-default-browser-check", "about:blank",
], { stdio: "ignore" });

let target;
for (let i = 0; i < 40; i++) {
  await sleep(250);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === "page");
    if (target) break;
  } catch {}
}
if (!target) { chrome.kill(); throw new Error("no chrome target"); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) pending.get(m.id)?.(m); };
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Runtime.enable");

async function rasterize(job) {
  const markPx = job.px * (1 - job.inset * 2);
  const pad = (job.px - markPx) / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${markPx}" height="${markPx}">${job.body}</svg>`;

  // Draw the SVG into a canvas, then hand back raw RGBA in 8k base64 chunks.
  const expr = `(async () => {
    const px = ${job.px}, markPx = ${markPx}, pad = ${pad};
    const svg = ${JSON.stringify(svg)};
    const img = new Image();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    await img.decode();
    const c = document.createElement("canvas");
    c.width = px; c.height = px;
    const ctx = c.getContext("2d");
    ctx.fillStyle = ${JSON.stringify(BONE)};
    ctx.fillRect(0, 0, px, px);
    ctx.drawImage(img, pad, pad, markPx, markPx);
    const d = ctx.getImageData(0, 0, px, px).data;
    let s = "";
    for (let i = 0; i < d.length; i += 8192) {
      s += String.fromCharCode.apply(null, d.subarray(i, i + 8192));
    }
    return btoa(s);
  })()`;

  const res = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  const b64 = res.result?.result?.value;
  if (typeof b64 !== "string") throw new Error(`rasterize failed for ${job.name}: ${JSON.stringify(res.result)}`);
  const rgba = Buffer.from(b64, "base64");
  if (rgba.length !== job.px * job.px * 4) throw new Error(`bad pixel count for ${job.name}: ${rgba.length}`);
  return encodePng(rgba, job.px, job.px);
}

for (const job of JOBS) {
  const png = await rasterize(job);
  const out = job.name.endsWith(".ico") ? icoWrap(png, job.px) : png;
  writeFileSync(join(OUT_DIR, job.name), out);
  console.log(`${job.name}  ${out.length} bytes  ${job.px}px  (RGBA png ${png.length}B)`);
}

ws.close();
chrome.kill();
