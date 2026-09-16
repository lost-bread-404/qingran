import { createFileRoute } from "@tanstack/react-router";
import { assertModelConfig, LONG_DRAIN_MS } from "@/lib/lover/brain/config";
import { enqueuePeriodicIfDue } from "@/lib/lover/brain/diary/dusk";
import { drainJobs } from "@/lib/lover/brain/jobs";
import { countPendingJobs, getMeta } from "@/lib/lover/brain/store";

function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization") ?? "";
  if (secret && auth === `Bearer ${secret}`) return true;
  if (!secret) {
    const host = request.headers.get("host") ?? "";
    if (host.startsWith("localhost") || host.startsWith("127.0.0.1")) return true;
  }
  return false;
}

export const Route = createFileRoute("/api/cron/brain")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!cronAuthorized(request)) {
          return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
        }
        try {
          assertModelConfig();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
        const tz = (await getMeta()).timeZone || "America/New_York";
        await enqueuePeriodicIfDue(Date.now(), tz);
        const ran = await drainJobs(LONG_DRAIN_MS);
        const pending = await countPendingJobs();
        return Response.json({ ok: true, ran, pending });
      },
    },
  },
});
