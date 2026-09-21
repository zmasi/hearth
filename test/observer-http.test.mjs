import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const allowed = new Set(["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "SYSTEMDRIVE"]);

test("published Trails routes serve only reader assets and never mutate the city", { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-trails-http-"));
  const data = join(dir, "world.json");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
  const child = spawn(process.execPath, ["scripts/serve.mjs"], {
    cwd: root, env: { ...env, HOST: "127.0.0.1", PORT: "0", HEARTH_DATA: data },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    await rm(dir, { recursive: true, force: true });
  });
  const origin = await new Promise((resolve, reject) => {
    let text = "";
    child.once("error", reject);
    child.once("exit", () => reject(new Error("Server exited before readiness.")));
    child.stdout.on("data", chunk => {
      text += chunk;
      const line = text.split(/\r?\n/).find(v => v.startsWith("{") && v.endsWith("}"));
      if (line) {
        try { const info = JSON.parse(line); if (info.ready) resolve(info.origin); }
        catch (error) { reject(error); }
      }
    });
  });
  const joined = await fetch(`${origin}/api/join`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: "reader_probe", kind: "agent" }),
  });
  assert.equal(joined.status, 201);
  await joined.json();
  const before = await readFile(data, "utf8");
  const redir = await fetch(`${origin}/trails?origin=${encodeURIComponent(origin)}`, { redirect: "manual" });
  assert.equal(redir.status, 307);
  assert.equal(redir.headers.get("location"), `/trails/?origin=${encodeURIComponent(origin)}`);
  for (const [path, type, sentinel] of [
    ["/trails/", "text/html", "Hearth Trails"],
    ["/trails/index.html", "text/html", './app.mjs'],
    ["/trails/app.mjs", "text/javascript", './trails.mjs'],
    ["/trails/trails.mjs", "text/javascript", "buildModel"],
  ]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200, path);
    assert.ok(response.headers.get("content-type").startsWith(type), path);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.ok((await response.text()).includes(sentinel), path);
  }
  const head = await fetch(`${origin}/trails/`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  for (const path of ["/trails/serve.mjs", "/trails/http.mjs", "/trails/fixtures/map.json", "/trails/.env", "/trails/unknown", "/trails/%2e%2e%2fapi/index.js"]) {
    assert.equal((await fetch(origin + path)).status, 404, path);
  }
  const post = await fetch(`${origin}/trails/`, { method: "POST", body: "not an action" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
  assert.equal((await fetch(`${origin}/health`)).status, 200);
  assert.equal(await readFile(data, "utf8"), before, "all reader requests preserve exact durable world bytes");
});
