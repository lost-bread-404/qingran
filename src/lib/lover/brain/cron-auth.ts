function isLocalDev(): boolean {
  return process.env.NODE_ENV !== "production" && !process.env.VERCEL && !process.env.NITRO;
}

export function cronAuthorized(request: Request): "ok" | "unauthorized" | "no-secret" {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization") ?? "";
  if (secret && auth === `Bearer ${secret}`) return "ok";
  if (!secret && !isLocalDev()) return "no-secret";
  if (!secret && isLocalDev()) {
    const host = request.headers.get("host") ?? "";
    if (host.startsWith("localhost") || host.startsWith("127.0.0.1")) return "ok";
  }
  return "unauthorized";
}

export function cronGate(request: Request): Response | null {
  const auth = cronAuthorized(request);
  if (auth === "no-secret") return Response.json({ ok: false, error: "CRON_SECRET is required" }, { status: 503 });
  if (auth !== "ok") return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  return null;
}
