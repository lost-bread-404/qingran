import { clientIp, failAttempt, isLimited, resetAttempt } from "../../../src/lib/auth-lite/attempts.ts";
import { safeNext } from "../../../src/lib/auth-lite/classify.ts";
import { renderLoginPage } from "../../../src/lib/auth-lite/login-page.ts";
import { passwordsMatch, sessionCookieHeader, signSession } from "../../../src/lib/auth-lite/session.ts";

interface LoginEvent {
  req: Request;
}

function redirect(to: string, cookie?: string): Response {
  const headers = new Headers({ Location: to });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

export default async function loginPost(event: LoginEvent): Promise<Response> {
  const password = (process.env.APP_PASSWORD ?? "").trim();
  if (!password) {
    return new Response("APP_PASSWORD 未设置", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const text = await event.req.text();
  const form = new URLSearchParams(text);
  const next = safeNext(form.get("next"));
  const given = form.get("password") ?? "";
  const ip = clientIp(event.req.headers.get("x-forwarded-for"));
  const now = Date.now();

  if (await isLimited(ip, now)) {
    return new Response(renderLoginPage({ next, error: "limited" }), {
      status: 429,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  if (!passwordsMatch(given, password)) {
    await failAttempt(ip, now);
    return redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
  }

  await resetAttempt(ip);
  const token = signSession(password, now);
  return redirect(next, sessionCookieHeader(token));
}
