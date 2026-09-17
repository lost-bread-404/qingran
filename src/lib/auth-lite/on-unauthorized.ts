import { safeNext } from "./classify.ts";

export function redirectToLogin(path?: string): void {
  if (typeof window === "undefined") return;
  if (window.location.pathname === "/login") return;
  const next = safeNext(path ?? `${window.location.pathname}${window.location.search}`);
  window.location.replace(`/login?next=${encodeURIComponent(next)}`);
}

/** 若是 401，跳去登录页并返回 true。`skip` 时只识别、不跳。 */
export function onUnauthorized(res: Response, opts?: { skip?: boolean }): boolean {
  if (res.status !== 401) return false;
  if (!opts?.skip) redirectToLogin();
  return true;
}
