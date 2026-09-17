import { safeNext } from "../../src/lib/auth-lite/classify.ts";
import { renderLoginPage } from "../../src/lib/auth-lite/login-page.ts";

interface LoginEvent {
  url: URL;
}

export default function loginPage(event: LoginEvent): Response {
  const errorRaw = event.url.searchParams.get("error");
  const error = errorRaw === "1" ? "bad" : errorRaw === "limited" ? "limited" : null;
  const html = renderLoginPage({
    next: safeNext(event.url.searchParams.get("next")),
    error,
  });
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
