import { createFileRoute } from "@tanstack/react-router";
import { lockedProfile, type ChatMessage, type Memory, type Profile } from "@/lib/lover/types";
import { runTalkStream, type TalkStreamInput } from "@/lib/lover/stream-talk";

export const Route = createFileRoute("/api/talk")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: TalkStreamInput;
        try {
          body = (await request.json()) as TalkStreamInput;
        } catch {
          return Response.json({ t: "err", m: "先说一句。" }, { status: 400 });
        }

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            const send = (event: unknown) => {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            };
            try {
              const input: TalkStreamInput = {
                text: String(body.text ?? ""),
                profile: lockedProfile(body.profile as Profile),
                history: Array.isArray(body.history) ? (body.history as ChatMessage[]) : [],
                memories: Array.isArray(body.memories) ? (body.memories as Memory[]) : [],
                nowMs: Number(body.nowMs) || Date.now(),
                timeZone: String(body.timeZone || "UTC"),
              };
              await runTalkStream(input, send);
            } catch {
              send({ t: "err", m: "线路有点不稳，稍后再说。" });
            } finally {
              controller.close();
            }
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      },
    },
  },
});
