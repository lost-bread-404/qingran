import { createFileRoute } from "@tanstack/react-router";
import { streamTicket } from "@/lib/lover/hearing/phone";

/**
 * The iPhone shell asks here, before each line of hers, how to stream her voice to xAI while she speaks: the
 * address (with her keyterms) and a secret that lasts a few minutes. No ticket → the shell sends the whole clip.
 */
export const Route = createFileRoute("/api/stt-stream")({
  server: {
    handlers: {
      POST: async () => {
        const ticket = await streamTicket().catch(() => null);
        if (!ticket) return Response.json({ ok: false });
        return Response.json({ ok: true, ...ticket }, { headers: { "Cache-Control": "no-store" } });
      },
    },
  },
});
