import { createFileRoute } from "@tanstack/react-router";
import { now } from "@/lib/lover/brain/clock";
import { assertModelConfig, LONG_DRAIN_MS } from "@/lib/lover/brain/config";
import { enqueuePeriodicIfDue } from "@/lib/lover/brain/diary/dusk";
import { drainJobs } from "@/lib/lover/brain/jobs";
import { countPendingJobs, getMeta } from "@/lib/lover/brain/store";
import { runRetention } from "@/lib/lover/brain/retention";
import { resolveTz } from "@/lib/lover/brain/tz";

function isLocalDev(): boolean {
  return process.env.NODE_ENV !== "production" && !process.env.VERCEL && !process.env.NITRO;
}

function cronAuthorized(request: Request): "ok" | "unauthorized" | "no-secret" {
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

export const Route = createFileRoute("/api/cron/brain")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = cronAuthorized(request);
        if (auth === "no-secret") {
          return Response.json({ ok: false, error: "CRON_SECRET is required" }, { status: 503 });
        }
        if (auth !== "ok") {
          return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
        }
        try {
          assertModelConfig();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
        const tz = resolveTz((await getMeta()).timeZone);
        await enqueuePeriodicIfDue(now(), tz);
        const ran = await drainJobs(LONG_DRAIN_MS);
        await runRetention();
        const pending = await countPendingJobs();
        return Response.json({ ok: true, ran, pending });
      },
    },
  },
});