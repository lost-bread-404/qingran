import { createFileRoute } from "@tanstack/react-router";
import { appendBrainLog } from "@/lib/lover/brain/store";
import { transcribeVoiceAudio } from "@/lib/lover/server";

export const Route = createFileRoute("/api/stt")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const started = Date.now();
        let body: { audioBase64?: string; mimeType?: string };
        try {
          body = (await request.json()) as { audioBase64?: string; mimeType?: string };
        } catch {
          return Response.json({ ok: false, error: "先给一段声音。" }, { status: 400 });
        }
        const audioBase64 = String(body.audioBase64 ?? "");
        const mimeType = typeof body.mimeType === "string" && body.mimeType ? body.mimeType : "audio/wav";
        const result = await transcribeVoiceAudio({ audioBase64, mimeType });
        const ms = Date.now() - started;
        await appendBrainLog({
          step: "stt",
          ok: result.ok,
          ms,
          route: "voice",
          note: "native",
          outputText: result.ok ? result.text.slice(0, 500) : null,
          error: result.ok ? null : result.error,
        }).catch(() => undefined);
        return Response.json({ ...result, ms });
      },
    },
  },
});
