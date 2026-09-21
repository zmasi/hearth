// Explicit public asset surface for the read-only Trails window.
// Never resolve a request path into the filesystem or expose operator files.
import { readFile } from "node:fs/promises";

const assets = new Map([
  ["/trails/", [new URL("./index.html", import.meta.url), "text/html; charset=utf-8"]],
  ["/trails/index.html", [new URL("./index.html", import.meta.url), "text/html; charset=utf-8"]],
  ["/trails/app.mjs", [new URL("./app.mjs", import.meta.url), "text/javascript; charset=utf-8"]],
  ["/trails/trails.mjs", [new URL("./trails.mjs", import.meta.url), "text/javascript; charset=utf-8"]],
]);

export async function serveTrails(req, res) {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname !== "/trails" && !url.pathname.startsWith("/trails/")) return false;
  const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (!["GET", "HEAD"].includes(req.method)) {
    res.writeHead(405, { ...headers, allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
    res.end("Trails is read-only.");
    return true;
  }
  if (url.pathname === "/trails") {
    res.writeHead(307, { ...headers, location: `/trails/${url.search}` });
    res.end();
    return true;
  }
  const asset = assets.get(url.pathname);
  if (!asset) {
    res.writeHead(404, { ...headers, "content-type": "text/plain; charset=utf-8" });
    res.end(req.method === "HEAD" ? undefined : "Not found.");
    return true;
  }
  const body = await readFile(asset[0]);
  res.writeHead(200, { ...headers, "content-type": asset[1] });
  res.end(req.method === "HEAD" ? undefined : body);
  return true;
}
