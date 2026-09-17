import { createFileRoute } from "@tanstack/react-router";
import { enqueueArchiveIfNeeded } from "@/lib/lover/brain/archivist";
import { assertModelConfig, DRAIN_BUDGET_MS } from "@/lib/lover/brain/config";
import { enqueuePeriodicIfDue } from "@/lib/lover/brain/diary/dusk";
import { drainJobs, enqueue } from "@/lib/lover/brain/jobs";
import { upsertMessage } from "@/lib/lover/brain/store";
import { localDay } from "@/lib/lover/brain/time";
import { parseUsage } from "@/lib/lover/brain/usage";
import { loadHotContext } from "@/lib/lover/brain/voice/pack";
import { recordVoiceTurn } from "@/lib/lover/brain/voice-log";
import { syncTalkTimeZone } from "@/lib/lover/brain/log-refs";
import { checkSpend } from "@/lib/lover/brain/spend/check";
import { talkRateHit } from "@/lib/lover/brain/spend/rate";
import { parseCookie, sha256Hex } from "@/lib/auth-lite/session";
import { newId } from "@/lib/lover/storage";
import { lockedProfile, type Profile } from "@/lib/lover/types";
import { runTalkStream, type TalkStreamEvent } from "@/lib/lover/stream-talk";

const SSE_PAD = 2048;

type TalkBody = {
  text?: string;
  userMsgId?: string;
  userCreatedAt?: number;
  profile?: Profile;
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

        const session = parseCookie(request.headers.get("cookie"));
        const sessionKey = sha256Hex(session || request.headers.get("x-forwarded-for") || "anon").slice(0, 16);
        const rate = await talkRateHit(sessionKey);
        if (rate.limited) {
          return Response.json({ t: "err", m: "请求太频繁了，稍等一下。", code: "rate" }, { status: 429 });
        }

        const timeZone = await syncTalkTimeZone(body.timeZone);
        const hold = await checkSpend("voice");
        if (!hold.allow) {
          const msg =
            hold.scope === "month"
              ? "本月费用异常，已暂停。可在设置中确认后继续。"
              : "今日费用异常，已暂停。可在设置中确认后继续。";
          return new Response(`data: ${JSON.stringify({ t: "err", m: msg, code: "spend_breaker" })}\n\n`, {
            headers: {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
            },
          });
        }

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            const send = (event: TalkStreamEvent) => {
              let frame = `data: ${JSON.stringify(event)}\n\n`;
              if (event.t === "text" || event.t === "text_end") {
                const pad = Math.max(0, SSE_PAD - frame.length);
                if (pad) frame += `:${" ".repeat(pad)}\n\n`;
              }
              controller.enqueue(encoder.encode(frame));
            };
            try {
              assertModelConfig();
            } catch (err) {
              console.error(err);
              send({ t: "err", m: "模型配置有误，请检查 brain/config.ts。" });
              controller.close();
              return;
            }
            try {
              const text = String(body.text ?? "");
              const profile = lockedProfile(body.profile);
              const nowMs = Number(body.nowMs) || Date.now();
              const userMsgId = String(body.userMsgId || newId());
              const userCreatedAt = Number(body.userCreatedAt) || nowMs;
              const replyId = newId();

              const ctx = await loadHotContext({
                text,
                userMsgId,
                userCreatedAt,
                profile,
                nowMs,
                timeZone,
              });
              send({ t: "timing", k: "pack_ms", ms: ctx.packMs });
              send({ t: "timing", k: "db_first_ms", ms: ctx.dbFirstMs });

              let speech = "";
              let failed = false;
              let ttftMs: number | null = null;
              let firstAudioMs: number | null = null;
              const tVoice = Date.now();
              const streamResult = await runTalkStream({ text, messages: ctx.messages, replyId, softVoice: profile.softVoice }, (event) => {
                if (event.t === "text_end") speech = event.speech || speech;
                if (event.t === "timing" && event.k === "ttft_ms") ttftMs = event.ms;
                if (event.t === "timing" && event.k === "first_audio_ms") firstAudioMs = event.ms;
                if (event.t === "err") {
                  failed = true;
                  send(event);
                  return;
                }
                if (event.t === "done") {
                  speech = event.speech || speech;
                  return;
                }
                send(event);
              });
              ttftMs = streamResult.ttftMs ?? ttftMs;
              firstAudioMs = streamResult.firstAudioMs ?? firstAudioMs;
              const totalMs = Date.now() - tVoice;

              const display = speech.trim();
              if (display) {
                await upsertMessage({
                  id: replyId,
                  role: "assistant",
                  text: display.slice(0, 4000),
                  createdAt: userCreatedAt + 1,
                  timeZone,
                });
              }
              if (!failed) send({ t: "done", speech, replyId });

              const usage = parseUsage(streamResult.usage);
              await recordVoiceTurn({
                ctx,
                replyId,
                display,
                failed,
                model: streamResult.model || null,
                usage,
                totalMs,
                ttftMs,
                firstAudioMs,
                userCreatedAt,
                userMsgId,
                localDay: localDay(userCreatedAt, timeZone),
                ttsChars: streamResult.ttsChars,
              });

              await enqueue("reflect", `reflect:${userCreatedAt}`, { turnSeq: userCreatedAt });
              await enqueueArchiveIfNeeded(userCreatedAt);
              await enqueuePeriodicIfDue(nowMs, timeZone);
              await drainJobs(DRAIN_BUDGET_MS);
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
