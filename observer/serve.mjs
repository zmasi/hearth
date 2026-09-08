// Local demo server for the observer: static files only, read-only, no world
// contact. Usage: node observer/serve.mjs [port]   (default 8811)
// Then open http://127.0.0.1:8811/            — live city, read-only GETs
//   or  http://127.0.0.1:8811/?map=fixtures/map.json&ledger=fixtures/ledger.json
//       — the synthetic fixture world used by the test-suite.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const port = Number(process.argv[2] || 8811);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    if (!path || path === ".") path = "index.html";
    const file = resolve(join(root, path));
    if (!file.startsWith(root)) {
      res.writeHead(403).end("no");
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[file.slice(file.lastIndexOf("."))] || "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
});
server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${port}/`, fixtures: `http://127.0.0.1:${port}/?map=fixtures/map.json&ledger=fixtures/ledger.json` }));
});
