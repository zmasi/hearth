import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { attachDatabasePool } from "@vercel/functions";
import { Pool } from "pg";

const PORT = Number(process.env.PORT || 8787);
const DATA = resolve(process.env.HEARTH_DATA || "/tmp/hearth.json");
const V = "3.1";
