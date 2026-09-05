import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { S as S1 } from "./seg1.js";
import { S as S2 } from "./seg2.js";
import { S as S3 } from "./seg3.js";
import { S as S4 } from "./seg4.js";
import { S as S5 } from "./seg5.js";

const vercelFunctions = import.meta.resolve("@vercel/functions");
const pg = import.meta.resolve("pg");
const source = (S1 + S2 + S3 + S4 + S5)
  .replaceAll('"@vercel/functions"', JSON.stringify(vercelFunctions))
  .replaceAll('"pg"', JSON.stringify(pg));
const assembled = `/tmp/hearth-kernel-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`;
writeFileSync(assembled, source);
const mod = await import(pathToFileURL(assembled).href);

export const __setBlobClientForTests = (...args) => mod.__setBlobClientForTests(...args);
export const __setPostgresPoolForTests = (...args) => mod.__setPostgresPoolForTests(...args);
export default mod.default;
