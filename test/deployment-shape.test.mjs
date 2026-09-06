import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

// Vercel makes every JS entry beneath api/ a function, not a source fragment.
test("Vercel receives one real kernel, never transport segments or a loader", () => {
  const api = new URL("../api/", import.meta.url);
  const entries = readdirSync(api, { recursive: true }).filter(name => /\.[cm]?js$/.test(name));
  assert.deepEqual(entries, ["index.js"]);
  const source = readFileSync(new URL("index.js", api), "utf8");
  assert.match(source, /export default function handler\(req, res\)/);
  assert.doesNotMatch(source, /data:text\/javascript|\.\/seg\d+\.js|PLACEHOLDER_USE_DISK|^\s*see-file/m);
});
