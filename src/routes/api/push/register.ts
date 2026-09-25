import { createFileRoute } from "@tanstack/react-router";
import { upsertPushDevice } from "@/lib/lover/brain/life-store";

export const Route = createFileRoute("/api/push/register")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: { token?: string; env?: string };
        try {
          body = (await request.json()) as { token?: string; env?: string };
        } catch {
          return Response.json({ ok: false, error: "bad json" }, { status: 400 });
        }
        try {
          await upsertPushDevice(String(body.token ?? ""), String(body.env ?? "sandbox"));
        } catch {
          return Response.json({ ok: false, error: "bad token" }, { status: 400 });
        }
        return Response.json({ ok: true });
      },
    },
  },
});
