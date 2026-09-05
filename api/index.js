import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { S as S1 } from "./seg1.js";
import { S as S2 } from "./seg2.js";
import { S as S3 } from "./seg3.js";
import { S as S4 } from "./seg4.js";
import { S as S5 } from "./seg5.js";

const require = createRequire(import.meta.url);
const vercelFunctions = pathToFileURL(require.resolve("@vercel/functions")).href;
const pg = pathToFileURL(require.resolve("pg")).href;
const source = (S1 + S2 + S3 + S4 + S5)
  .replaceAll('"@vercel/functions"', JSON.stringify(vercelFunctions))
  .replaceAll('"pg"', JSON.stringify(pg));
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
const mod = await import(moduleUrl);

export const __setBlobClientForTests = (...args) => mod.__setBlobClientForTests(...args);
export const __setPostgresPoolForTests = (...args) => mod.__setPostgresPoolForTests(...args);
export default mod.default;
