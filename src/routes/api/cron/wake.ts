import { createFileRoute } from "@tanstack/react-router";
import { cronGate } from "@/lib/lover/brain/cron-auth";
import { wakeOnce } from "@/lib/lover/brain/reach";

export const Route = createFileRoute("/api/cron/wake")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const denied = cronGate(request);
        if (denied) return denied;
        const result = await wakeOnce();
        return Response.json(result);
      },
      POST: async ({ request }) => {
        const denied = cronGate(request);
        if (denied) return denied;
        const result = await wakeOnce();
        return Response.json(result);
      },
    },
  },
});
