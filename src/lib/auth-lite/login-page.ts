import { safeNext } from "./classify.ts";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&" + "amp;")
    .replace(/"/g, "&" + "quot;")
    .replace(/</g, "&" + "lt;")
    .replace(/>/g, "&" + "gt;");
}

export function renderLoginPage(opts: {
  next?: string;
  error?: "bad" | "limited" | null;
}): string {
  const next = safeNext(opts.next);
  const message =
    opts.error === "limited"
      ? "试得有点勤，过一会儿再来。"
      : opts.error === "bad"
        ? "密码不对。"
        : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="color-scheme" content="dark" />
  <title>清然</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100dvh;
      display: grid;
      place-items: center;
      padding: max(1.5rem, env(safe-area-inset-top)) 1.25rem max(1.5rem, env(safe-area-inset-bottom));
      background: #0c0b0a;
      color: #f2ece4;
      font-family: ui-sans-serif, system-ui, sans-serif;
    }
    form {
      width: min(100%, 22rem);
      display: flex;
      flex-direction: column;
      gap: 0.85rem;
    }
    h1 { font-size: 1.6rem; font-weight: 500; margin: 0 0 0.25rem; }
    p { margin: 0; color: #9a9288; font-size: 0.9rem; }
    .err { color: #b07070; }
    input[type=password] {
      width: 100%;
      height: 2.75rem;
      border: 0;
      border-radius: 12px;
      padding: 0 0.9rem;
      background: #1e1b18;
      color: #f2ece4;
      font-size: 16px;
    }
    button {
      height: 2.75rem;
      border: 0;
      border-radius: 999px;
      background: #cfc4b6;
      color: #0c0b0a;
      font-size: 1rem;
      font-weight: 500;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <form method="post" action="/api/login" autocomplete="on">
    <h1>清然</h1>
    <p>输入密码就能进来。</p>
    ${message ? `<p class="err">${escapeHtml(message)}</p>` : ""}
    <input type="hidden" name="next" value="${escapeHtml(next)}" />
    <input type="password" name="password" autocomplete="current-password" required autofocus />
    <button type="submit">进入</button>
  </form>
</body>
</html>`;
}
