import assert from "node:assert/strict";
import { copyFile, glob, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

test("Vercel explicitly packages every public Trails asset; a traced-helper-only package fails", async t => {
  const temp = await mkdtemp(join(tmpdir(), "hearth-packaged-trails-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await mkdir(join(temp, "observer"));
  await copyFile(join(root, "observer/http.mjs"), join(temp, "observer/http.mjs"));
  const { serveTrails } = await import(pathToFileURL(join(temp, "observer/http.mjs")).href);
  const response = () => ({ status: null, headers: null, body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; } });
  // Node File Trace follows the helper import, but cannot infer assets read
  // through its Map lookup. This negative control reproduces the omitted-file
  // runtime failure without changing or contacting the real city.
  await assert.rejects(serveTrails({ method: "GET", url: "/trails/" }, response()), { code: "ENOENT" });
  const config = JSON.parse(await readFile(join(root, "vercel.json"), "utf8"));
  const pattern = config.functions?.["api/index.js"]?.includeFiles;
  assert.equal(typeof pattern, "string", "the function must declare runtime assets");
  const included = [];
  for await (const file of glob(pattern, { cwd: root })) {
    included.push(file.replaceAll("\\", "/"));
    const target = join(temp, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(root, file), target);
  }
  assert.deepEqual(included.sort(), ["observer/app.mjs", "observer/index.html", "observer/trails.mjs"]);
  for (const [route, file, type] of [["/trails/", "index.html", "text/html"],
    ["/trails/app.mjs", "app.mjs", "text/javascript"], ["/trails/trails.mjs", "trails.mjs", "text/javascript"]]) {
    const res = response();
    assert.equal(await serveTrails({ method: "GET", url: route }, res), true);
    assert.equal(res.status, 200);
    assert.ok(res.headers["content-type"].startsWith(type));
    assert.deepEqual(res.body, await readFile(join(root, "observer", file)));
  }
  const denied = response();
  await serveTrails({ method: "GET", url: "/trails/fixtures/map.json" }, denied);
  assert.equal(denied.status, 404, "packaging does not widen the public HTTP allowlist");
});
