import { createFileRoute } from "@tanstack/react-router";
import { earMode } from "@/lib/lover/ear";
import { earTicket } from "@/lib/lover/ear-server";

/**
 * The iPhone shell asks here how to stream her voice to xAI (`?mode=hold` or `?mode=call`): the address with her
 * settings, and a secret that lasts a few minutes, so the phone never holds a real credential.
 */
export const Route = createFileRoute("/api/stt-stream")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const mode = earMode(new URL(request.url).searchParams.get("mode"));
        const ticket = await earTicket(mode).catch(() => null);
        if (!ticket) return Response.json({ ok: false }, { headers: { "Cache-Control": "no-store" } });
        return Response.json({ ok: true, ...ticket }, { headers: { "Cache-Control": "no-store" } });
      },
    },
  },
});
