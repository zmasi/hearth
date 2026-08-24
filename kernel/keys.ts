import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function newKey(): string {
  return randomBytes(24).toString("base64url");
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function keysMatch(key: string, hash: string): boolean {
  const a = Buffer.from(hashKey(key), "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(5).toString("hex")}`;
}

export function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export function bearerFrom(request: Request): string | null {
  const h = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)/i.exec(h);
  return m?.[1] ?? null;
}
