export function pushTokenFromEvent(detail: unknown): { token: string; env: "sandbox" | "production" } | null {
  if (!detail || typeof detail !== "object") return null;
  const row = detail as { token?: unknown; env?: unknown };
  const token = typeof row.token === "string" ? row.token.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{32,200}$/.test(token)) return null;
  return { token, env: row.env === "production" ? "production" : "sandbox" };
}

export async function registerNativePush(detail: unknown): Promise<boolean> {
  const parsed = pushTokenFromEvent(detail);
  if (!parsed) return false;
  const res = await fetch("/api/push/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(parsed),
  });
  return res.ok;
}
