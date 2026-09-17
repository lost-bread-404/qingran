/**
 * Production (Nitro) password gate. vite dev does not load this directory.
 * Filename `00-` so it runs before grok-pwa.ts (Nitro middleware is alphabetical).
 */
import {
  classifyRequest,
  safeNext,
} from "../../src/lib/auth-lite/classify.ts";
import { parseCookie, verifySession } from "../../src/lib/auth-lite/session.ts";

interface AuthEvent {
  url: URL;
  req: { method: string; headers: Headers };
}

function appPassword(): string | undefined {
  const v = process.env.APP_PASSWORD;
  return v && v.trim() ? v.trim() : undefined;
}

function isCron(path: string): boolean {
  return path === "/api/cron/brain" || path.startsWith("/api/cron/brain/");
}

export default async function authMiddleware(
  event: AuthEvent,
  next: () => unknown | Promise<unknown>,
): Promise<unknown> {
  const method = (event.req.method ?? "GET").toUpperCase();
  const path = event.url.pathname || "/";
  const password = appPassword();

  if (!password) {
    if (isCron(path)) return next();
    return new Response("APP_PASSWORD 未设置", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const token = parseCookie(event.req.headers.get("cookie"));
  const cookieValid = verifySession(token, password);
  const decision = classifyRequest(method, path, event.req.headers.get("accept"), cookieValid);
  if (decision === "next") return next();
  if (decision === "redirect") {
    const orig = `${path}${event.url.search ?? ""}`;
    const nextPath = encodeURIComponent(safeNext(orig));
    return new Response(null, {
      status: 302,
      headers: { Location: `/login?next=${nextPath}` },
    });
  }
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
