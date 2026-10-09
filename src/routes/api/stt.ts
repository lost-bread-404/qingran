import { createFileRoute } from "@tanstack/react-router";
import { recordSttSpend } from "@/lib/lover/brain/spend/check";
import { tidyHeard } from "@/lib/lover/ear";
import { hearWholeClip } from "@/lib/lover/ear-server";

/**
 * A held line whose stream could not be opened: the recording (16 kHz WAV, base64, at most a minute per request) is
 * read at once. Returns the words, or an error to show her. Streaming is the normal way (src/lib/lover/ear.ts).
 */
export const Route = createFileRoute("/api/stt")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: { audioBase64?: unknown; streamText?: unknown };
        try {
          body = (await request.json()) as { audioBase64?: unknown; streamText?: unknown };
        } catch {
          return Response.json({ ok: false, error: "没收到声音。" }, { status: 400 });
        }
        const audio = typeof body.audioBase64 === "string" ? body.audioBase64 : "";
        // An iPhone shell from before 2026-10-06 sends each call line here with what xAI already heard while she
        // said it: those words are hers (its streamed seconds are counted here, it does not report them).
        if (typeof body.streamText === "string" && body.streamText.trim()) {
          void recordSttSpend(Math.max(0, (audio.length * 3) / 4 - 44) / 32_000, true).catch(() => undefined);
          return Response.json({ ok: true, text: tidyHeard(body.streamText) }, { headers: { "Cache-Control": "no-store" } });
        }
        const heard = await hearWholeClip(audio);
        return Response.json(heard, { headers: { "Cache-Control": "no-store" } });
      },
    },
  },
});
