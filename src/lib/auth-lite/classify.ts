export type AuthDecision = "next" | "redirect" | "unauthorized";

const PUBLIC_EXACT = new Set([
  "/__grok/manifest.webmanifest",
  "/__grok/manifest.json",
  "/__grok/icon-180.png",
  "/og.jpg",
  "/x-banner.jpg",
]);

const PUBLIC_PREFIX = [
  "/assets/",
  "/icons/",
  "/__grok/install/",
];

const PUBLIC_STARTS = ["/favicon", "/apple-touch-icon"];

export function isPublicPath(method: string, path: string): boolean {
  const m = method.toUpperCase();
  const p = path.split("?")[0] || "/";
  if (m === "GET" && p === "/login") return true;
  if (m === "POST" && p === "/api/login") return true;
  if (m === "POST" && p === "/api/logout") return true;
  if (p === "/api/cron/brain" || p.startsWith("/api/cron/brain/")) return true;
  if (p === "/api/cron/wake" || p.startsWith("/api/cron/wake/")) return true;
  if (PUBLIC_EXACT.has(p)) return true;
  if (p === "/assets" || p === "/icons") return true;
  for (const prefix of PUBLIC_PREFIX) {
    if (p.startsWith(prefix)) return true;
  }
  for (const start of PUBLIC_STARTS) {
    if (p.startsWith(start)) return true;
  }
  return false;
}

export function classifyRequest(
  method: string,
  path: string,
  accept: string | null | undefined,
  cookieValid: boolean,
): AuthDecision {
  if (isPublicPath(method, path)) return "next";
  if (cookieValid) return "next";
  const m = method.toUpperCase();
  if (m === "GET" && (accept ?? "").toLowerCase().includes("text/html")) return "redirect";
  return "unauthorized";
}

/** 只允许站内路径，挡住 //evil.com 这类开放重定向。 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return "/";
  let v = raw.trim();
  try {
    v = decodeURIComponent(v);
  } catch {
    return "/";
  }
  v = v.trim();
  if (!v.startsWith("/")) return "/";
  if (v.startsWith("//") || v.startsWith("/\\")) return "/";
  if (v.includes("://") || v.includes("\\") || /[\0\r\n]/.test(v)) return "/";
  return v;
}
