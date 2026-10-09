import { createFileRoute } from "@tanstack/react-router";
import { cronGate } from "@/lib/lover/brain/cron-auth";
import { wakeOnce } from "@/lib/lover/brain/reach";
import { drainJobs } from "@/lib/lover/brain/jobs";
import { LONG_DRAIN_MS } from "@/lib/lover/brain/config";
import { runInBackground } from "@/lib/lover/brain/wait-until";

async function handle(request: Request): Promise<Response> {
  const denied = cronGate(request);
  if (denied) return denied;
  const t0 = Date.now();
  const result = await wakeOnce();
  // The night pass (and anything else queued) runs after the response, in what is left of the function's time: a
  // message he starts can take a thinking model a while, and a job that no longer fits waits for the next wake.
  await runInBackground(() => drainJobs(Math.max(0, LONG_DRAIN_MS - (Date.now() - t0))));
  return Response.json(result);
}

export const Route = createFileRoute("/api/cron/wake")({
  server: {
    handlers: {
      GET: async ({ request }) => handle(request),
      POST: async ({ request }) => handle(request),
    },
  },
});
