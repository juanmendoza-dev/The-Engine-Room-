import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const mime = { ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".css": "text/css" };

const server = http.createServer(async (req, res) => {
  const name = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = name === "/" ? "index.html" : name.slice(1);
  const full = path.join(root, path.normalize(file));
  if (!full.startsWith(root)) { res.writeHead(403); res.end(); return; }
  try {
    const body = await readFile(full);
    res.writeHead(200, {
      "content-type": mime[path.extname(full)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404); res.end("not found");
  }
});

const ports = [4173, 4174, 4175, 4176];
function tryListen(i) {
  if (i >= ports.length) { console.error("no free port"); process.exit(1); }
  server.once("error", (e) => {
    if (e.code === "EADDRINUSE") tryListen(i + 1); else throw e;
  });
  server.listen(ports[i], "127.0.0.1", () => {
    console.log(`gallery up at http://localhost:${ports[i]}/`);
  });
}
tryListen(0);
