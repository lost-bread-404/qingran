import { createFileRoute } from "@tanstack/react-router";
import { now } from "@/lib/lover/brain/clock";
import { assertModelConfig, LONG_DRAIN_MS } from "@/lib/lover/brain/config";
import { cronGate } from "@/lib/lover/brain/cron-auth";
import { enqueuePeriodicIfDue } from "@/lib/lover/brain/diary/dusk";
import { drainJobs } from "@/lib/lover/brain/jobs";
import { countPendingJobs, getMeta } from "@/lib/lover/brain/store";
import { runRetention } from "@/lib/lover/brain/retention";
import { resolveTz } from "@/lib/lover/brain/tz";
import { getSql } from "@/lib/db";
import { maybeRebuildLexicon } from "@/lib/lover/hearing/persist";

export const Route = createFileRoute("/api/cron/brain")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const denied = cronGate(request);
        if (denied) return denied;
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
        try {
          await maybeRebuildLexicon(await getSql());
        } catch (err) {
          console.error("[cron] lexicon rebuild", err);
        }
        const pending = await countPendingJobs();
        return Response.json({ ok: true, ran, pending });
      },
    },
  },
});
