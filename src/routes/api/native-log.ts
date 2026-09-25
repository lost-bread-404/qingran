import { createFileRoute } from "@tanstack/react-router";
import { appendBrainLog } from "@/lib/lover/brain/store";
import { nativeCallLogRow } from "@/lib/lover/native-log";

export const Route = createFileRoute("/api/native-log")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: unknown = {};
        try {
          body = await request.json();
        } catch {
          body = {};
        }
        const row = nativeCallLogRow(body);
        await appendBrainLog({
          step: "native-call",
          ok: row.ok,
          ms: row.ms,
          route: "voice",
          note: row.note,
          error: row.error,
        }).catch(() => undefined);
        return Response.json({ ok: true });
      },
    },
  },
});
