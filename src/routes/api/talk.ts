import { createFileRoute } from "@tanstack/react-router";
import { noteRosieTurn } from "@/lib/lover/brain/dossier";
import { enqueueArchiveIfNeeded } from "@/lib/lover/brain/archivist";
import { assertModelConfig, LONG_DRAIN_MS, resolveVoiceChat, voiceSafetyPick } from "@/lib/lover/brain/config";
import { enqueuePeriodicIfDue } from "@/lib/lover/brain/diary/dusk";
import { drainJobs } from "@/lib/lover/brain/jobs";
import { commitReplyInner } from "@/lib/lover/brain/reply-inner";
import { runInBackground } from "@/lib/lover/brain/wait-until";
import { upsertMessage } from "@/lib/lover/brain/store";
import { localDay } from "@/lib/lover/brain/time";
import { loadHotContext } from "@/lib/lover/brain/voice/pack";
import { runVoiceWithFallback, formatVoiceLogNote } from "@/lib/lover/brain/voice/voice-fallback";
import { recordVoiceTurn } from "@/lib/lover/brain/voice-log";
import { syncTalkTimeZone } from "@/lib/lover/brain/log-refs";
import { checkSpend } from "@/lib/lover/brain/spend/check";
import { talkRateHit } from "@/lib/lover/brain/spend/rate";
import { parseCookie, sha256Hex } from "@/lib/auth-lite/session";
import { newId } from "@/lib/lover/storage";
import { formatVoiceInjectLine, lockedProfile, type Profile } from "@/lib/lover/types";
import { lookupBusyRange } from "@/lib/lover/brain/busy";
import { loadPrompt } from "@/lib/lover/brain/prompts/store";
import { parsePromptBody, renderVariant } from "@/lib/lover/brain/prompts/doc";
import { type TalkStreamEvent } from "@/lib/lover/stream-talk";
import { logTalkTurn, talkFailFromResult } from "@/lib/lover/talk-fail";
import { recordTurnTrace } from "@/lib/lover/brain/turn-trace";

const SSE_PAD = 2048;

type TalkBody = {
  text?: string;
  userMsgId?: string;
  userCreatedAt?: number;
  replyId?: string;
  replyCreatedAt?: number;
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
            const started = Date.now();
            let packed: Awaited<ReturnType<typeof loadHotContext>> | null = null;
            let replyId = "";
            let userMsgId = "";
            let userCreatedAt = 0;
            let speech = "";
            let tVoice = started;
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
              userMsgId = String(body.userMsgId || newId());
              userCreatedAt = Number(body.userCreatedAt) || nowMs;
              replyId = String(body.replyId || "").trim() || newId();

              packed = await loadHotContext({
                text,
                userMsgId,
                userCreatedAt,
                profile,
                nowMs,
                timeZone,
              });
              const ctx = packed;
              send({ t: "timing", k: "pack_ms", ms: ctx.packMs });
              send({ t: "timing", k: "db_first_ms", ms: ctx.dbFirstMs });

              let ttftMs: number | null = null;
              let firstAudioMs: number | null = null;
              const interrupted = false;
              tVoice = Date.now();
              const primary = resolveVoiceChat(profile.voiceModel, profile.voiceEffort);
              const safety = voiceSafetyPick();
              const busyTool = await loadPrompt("busy_tool").catch(() => null);
              const busyDescription = busyTool
                ? renderVariant(parsePromptBody("busy_tool", busyTool.body), "main", {})
                    .find((message) => message.role === "system")
                    ?.content ?? ""
                : "";
              const toolStarted = { ms: 0, name: "", args: "" };
              let sentDone = false;
              const fallback = await runVoiceWithFallback(
                {
                  text,
                  parts: ctx.parts,
                  replyId,
                  voiceSpeed: profile.voiceSpeed,
                  primary,
                  safety,
                  tools: busyDescription
                    ? [
                        {
                          type: "function" as const,
                          function: {
                            name: "busy_lookup",
                            description: busyDescription,
                            parameters: {
                              type: "object",
                              additionalProperties: false,
                              required: ["from_day", "to_day"],
                              properties: {
                                from_day: { type: "string" },
                                to_day: { type: "string" },
                              },
                            },
                          },
                        },
                      ]
                    : undefined,
                  resolveTool: async (call) => {
                    const started = Date.now();
                    let args: { from_day?: string; to_day?: string } = {};
                    try {
                      args = JSON.parse(call.arguments) as { from_day?: string; to_day?: string };
                    } catch {
                      args = {};
                    }
                    const result = await lookupBusyRange(String(args.from_day ?? ""), String(args.to_day ?? ""));
                    toolStarted.ms = Date.now() - started;
                    toolStarted.name = call.name;
                    toolStarted.args = call.arguments.slice(0, 180);
                    return JSON.stringify(result);
                  },
                },
                (event) => {
                  if (event.t === "timing" && event.k === "ttft_ms") ttftMs = event.ms;
                  if (event.t === "timing" && event.k === "first_audio_ms") firstAudioMs = event.ms;
                  if (event.t === "err") {
                    send(event);
                    return;
                  }
                  if (event.t === "done") {
                    speech = event.speech || speech;
                    if (!sentDone) {
                      sentDone = true;
                      send(event);
                    }
                    return;
                  }
                  send(event);
                },
              );
              const streamResult = fallback.result;
              speech = fallback.speech;
              const failed = fallback.failed;
              ttftMs = streamResult.ttftMs ?? ttftMs;
              firstAudioMs = streamResult.firstAudioMs ?? firstAudioMs;
              const totalMs = Date.now() - tVoice;

              const display = speech.trim();
              const replyAt = Number(body.replyCreatedAt);
              if (display) {
                await upsertMessage({
                  id: replyId,
                  role: "assistant",
                  text: `⟦回:${userMsgId}⟧${display}`,
                  createdAt: Number.isFinite(replyAt) && replyAt > 0 ? replyAt : userCreatedAt + 1,
                  timeZone,
                });
              }
              if (!failed && !sentDone) {
                send({
                  t: "done",
                  speech,
                  replyId,
                  status: streamResult.status,
                  finishReason: streamResult.finishReason,
                  ms: streamResult.ms,
                  chars: streamResult.chars,
                  ttftMs: ttftMs ?? undefined,
                });
              }

              const usage = fallback.usage;
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
                finishReason: streamResult.finishReason,
                effort: streamResult.effort == null ? null : String(streamResult.effort),
                note: formatVoiceLogNote({
                  attempts: fallback.attempts,
                  usedStrip: fallback.usedStrip,
                  chars: ctx.inputChars,
                  failed,
                  failMessage: fallback.failMessage,
                  modelFallback: fallback.modelFallback,
                  injectLine: formatVoiceInjectLine(ctx.inject),
                  toolLine: fallback.toolNote,
                }),
              });
              await recordTurnTrace({
                turnId: replyId,
                userMsgId,
                turnSeq: userCreatedAt,
                live: {
                  historyCount: ctx.historyIds.length,
                  promptHash: ctx.charterHash,
                  model: streamResult.model,
                  ms: totalMs,
                  injectMoment: ctx.inject.moment,
                  injectDossier: ctx.inject.dossier,
                  historyWindow: ctx.inject.history,
                  injectLine: formatVoiceInjectLine(ctx.inject),
                  inner: ctx.injected,
                  tool: toolStarted.name
                    ? { name: toolStarted.name, arguments: toolStarted.args, ms: toolStarted.ms }
                    : null,
                },
                reply: {
                  text: display,
                  finishReason: streamResult.finishReason,
                  interrupted,
                },
              });

              if (!failed && display) {
                await commitReplyInner({
                  turnSeq: userCreatedAt,
                  tail: streamResult.innerCut ? (streamResult.innerTail ?? "") : null,
                  model: streamResult.model || null,
                  ms: streamResult.ms,
                });
              }
              await noteRosieTurn(userCreatedAt);
              await enqueueArchiveIfNeeded(userCreatedAt, ctx.inject.history);
              await enqueuePeriodicIfDue(nowMs, timeZone);
              await runInBackground(() => drainJobs(LONG_DRAIN_MS));
            } catch (err) {
              const outcome = talkFailFromResult({
                kind: "exception",
                threw: err,
                ms: Date.now() - started,
              });
              logTalkTurn(outcome.log);
              send({
                t: "err",
                m: outcome.message ?? "线路有点不稳",
                status: outcome.log.status,
                finishReason: outcome.log.finishReason,
                ms: outcome.log.ms,
                chars: outcome.log.chars,
              });
              if (packed) {
                const note = [
                  outcome.message ?? "线路有点不稳",
                  outcome.log.errorName ? `${outcome.log.errorName}: ${outcome.log.errorMessage}` : null,
                  `ms=${outcome.log.ms}`,
                  packed ? formatVoiceInjectLine(packed.inject) : null,
                ]
                  .filter(Boolean)
                  .join("\n");
                await recordVoiceTurn({
                  ctx: packed,
                  replyId: replyId || newId(),
                  display: speech.trim(),
                  failed: true,
                  model: null,
                  usage: {},
                  totalMs: Date.now() - tVoice,
                  ttftMs: null,
                  firstAudioMs: null,
                  userCreatedAt: userCreatedAt || started,
                  userMsgId: userMsgId || newId(),
                  localDay: localDay(userCreatedAt || started, timeZone),
                  finishReason: null,
                  note,
                }).catch((logErr) => console.error(logErr));
              }
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
