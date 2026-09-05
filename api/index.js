import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { S as S1 } from "./seg1.js";
import { S as S2 } from "./seg2.js";
import { S as S3 } from "./seg3.js";
import { S as S4 } from "./seg4.js";
import { S as S5 } from "./seg5.js";

const require = createRequire(import.meta.url);

let loaded = null;
async function kernel() {
  if (loaded) return loaded;
  const vercelFunctions = pathToFileURL(require.resolve("@vercel/functions")).href;
  const pg = pathToFileURL(require.resolve("pg")).href;
  const source = (S1 + S2 + S3 + S4 + S5)
    .replaceAll('"@vercel/functions"', JSON.stringify(vercelFunctions))
    .replaceAll('"pg"', JSON.stringify(pg));
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
  loaded = await import(moduleUrl);
  return loaded;
}

export async function __setBlobClientForTests(...args) {
  const mod = await kernel();
  return mod.__setBlobClientForTests(...args);
}
export async function __setPostgresPoolForTests(...args) {
  const mod = await kernel();
  return mod.__setPostgresPoolForTests(...args);
}
export default async function handler(req, res) {
  const mod = await kernel();
  return mod.default(req, res);
}
