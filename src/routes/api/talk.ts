import { createFileRoute } from "@tanstack/react-router";
import { labelChatMessage } from "@/lib/lover/memory/pack";
import { runTalkStream, type TalkStreamInput } from "@/lib/lover/stream-talk";
import { lockedProfile, type ChatMessage, type Profile } from "@/lib/lover/types";

type TalkBody = {
  text?: string;
  profile?: Profile;
  history?: ChatMessage[];
  nowMs?: number;
  timeZone?: string;
};

export const Route = createFileRoute("/api/talk")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: TalkBody;
        try {
          body = (await request.json()) as TalkBody;
        } catch {
          return Response.json({ t: "err", m: "先说一句。" }, { status: 400 });
        }

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            const send = (event: unknown) => {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            };
            const timeZone = String(body.timeZone || "UTC");
            try {
              const profile = lockedProfile(body.profile);
              const history = Array.isArray(body.history) ? body.history : [];
              const text = String(body.text ?? "");
              const { assembleMainPack, tickMemory } = await import("@/lib/lover/memory/channel");
              let messages: TalkStreamInput["messages"] = [];
              try {
                const packed = await assembleMainPack({
                  charter: profile.systemPrompt,
                  history,
                  userText: text,
                  nowMs: Number(body.nowMs) || Date.now(),
                  timeZone,
                });
                messages = packed.messages;
              } catch {
                messages = [
                  { role: "system", content: profile.systemPrompt },
                  ...history.slice(-19).map((m) => labelChatMessage(m.role, m.text)),
                  labelChatMessage("user", text),
                ];
              }
              await runTalkStream({ text, messages }, send);
              void tickMemory(timeZone);
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
