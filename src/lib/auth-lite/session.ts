import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "qr_session";
export const SESSION_MAX_AGE_MS = 365 * 86_400_000;
export const SESSION_MAX_AGE_SEC = 31_536_000;
const MSG_PREFIX = "qingran-session:v1:";
const SKEW_MS = 60_000;

export function signSession(password: string, issuedAtMs: number): string {
  const sig = hmac(password, issuedAtMs);
  return `v1.${issuedAtMs}.${sig}`;
}

export function verifySession(
  value: string | null | undefined,
  password: string,
  nowMs = Date.now(),
): boolean {
  if (!value || !password) return false;
  const m = /^v1\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(value);
  if (!m) return false;
  const issuedAt = Number(m[1]);
  if (!Number.isFinite(issuedAt)) return false;
  if (issuedAt > nowMs + SKEW_MS) return false;
  if (nowMs - issuedAt > SESSION_MAX_AGE_MS) return false;
  const expected = hmac(password, issuedAt);
  return timingSafeEqualUtf8(m[2]!, expected);
}

export function parseCookie(header: string | null | undefined, name = SESSION_COOKIE): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return part.slice(idx + 1).trim();
  }
  return null;
}

export function sessionCookieHeader(value: string, maxAgeSec = SESSION_MAX_AGE_SEC): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`;
}

export function clearSessionCookieHeader(): string {
  return sessionCookieHeader("", 0);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function passwordsMatch(given: string, expected: string): boolean {
  return timingSafeEqualUtf8(sha256Hex(given), sha256Hex(expected));
}

function hmac(password: string, issuedAtMs: number): string {
  return createHmac("sha256", password).update(`${MSG_PREFIX}${issuedAtMs}`).digest("base64url");
}

function timingSafeEqualUtf8(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
