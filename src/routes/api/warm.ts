import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";

export const Route = createFileRoute("/api/warm")({
  server: {
    handlers: {
      GET: async () => {
        const t0 = Date.now();
        try {
          const db = await getSql();
          await db.query("select 1");
          return Response.json({ ok: true, ms: Date.now() - t0 });
        } catch {
          return Response.json({ ok: false, ms: Date.now() - t0 }, { status: 500 });
        }
      },
    },
  },
});
