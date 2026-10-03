import { createFileRoute } from "@tanstack/react-router";
import { assertModelConfig, LONG_DRAIN_MS, resolveVoiceChat, voiceSafetyPick } from "@/lib/lover/brain/config";
import { enqueueReportIfDue } from "@/lib/lover/brain/diary/report";
import { drainJobs } from "@/lib/lover/brain/jobs";
import { runInBackground } from "@/lib/lover/brain/wait-until";
import { upsertMessage, appendBrainLog, getMessage, getProfileData, newerAttempt, messageForgotten } from "@/lib/lover/brain/store";
import { localDay } from "@/lib/lover/brain/time";
import { loadHotContext } from "@/lib/lover/brain/voice/pack";
import { runVoiceWithFallback, formatVoiceLogNote } from "@/lib/lover/brain/voice/voice-fallback";
import { recordVoiceTurn } from "@/lib/lover/brain/voice-log";
import { syncTalkTimeZone } from "@/lib/lover/brain/log-refs";
import { talkRateHit } from "@/lib/lover/brain/spend/rate";
import { parseCookie, sha256Hex } from "@/lib/auth-lite/session";
import { newId } from "@/lib/lover/storage";
import { formatVoiceInjectLine, type Profile } from "@/lib/lover/types";
import { parseCast } from "@/lib/lover/cast";
import { resolveTalkProfile } from "@/lib/lover/talk-profile";
import { type TalkStreamEvent } from "@/lib/lover/stream-talk";
import { logTalkTurn, talkFailFromResult } from "@/lib/lover/talk-fail";

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
  /** Photos sent with this line (qr_photos ids). */
  images?: string[];
  /** The phone's round: her earlier short messages before this one, each kept as its own message. */
  earlier?: { id?: string; text?: string; at?: number }[];
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

        const encoder = new TextEncoder();
        // The phone dropped this request (she went on before his voice started): nothing more is sent, and writing
        // to the closed stream must not look like a model failure (that would retry the whole reply).
        let gone = false;
        const stream = new ReadableStream({
          cancel() {
            gone = true;
          },
          async start(controller) {
            const send = (event: TalkStreamEvent) => {
              if (gone) return;
              let frame = `data: ${JSON.stringify(event)}\n\n`;
              if (event.t === "text" || event.t === "text_end") {
                const pad = Math.max(0, SSE_PAD - frame.length);
                if (pad) frame += `:${" ".repeat(pad)}\n\n`;
              }
              try {
                controller.enqueue(encoder.encode(frame));
              } catch {
                gone = true;
              }
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
              const savedProfile = await getProfileData();
              const resolved = resolveTalkProfile(body.profile, savedProfile);
              const profile = resolved.profile;
              if (resolved.personaMissing) {
                await appendBrainLog({
                  step: "persona_missing",
                  ok: false,
                  note: "persona_missing",
                  error: "persona_missing",
                  route: "voice",
                });
              }
              const nowMs = Number(body.nowMs) || Date.now();
              userMsgId = String(body.userMsgId || newId());
              userCreatedAt = Number(body.userCreatedAt) || nowMs;
              replyId = String(body.replyId || "").trim() || newId();
              const round = Array.isArray(body.earlier);
              for (const item of round ? body.earlier! : []) {
                const id = String(item?.id || "");
                const said = String(item?.text || "").trim();
                if (!id || !said || (await getMessage(id))) continue;
                await upsertMessage({ id, role: "user", text: said, createdAt: Number(item.at) || userCreatedAt - 1, timeZone });
              }

              packed = await loadHotContext({
                text,
                userMsgId,
                userCreatedAt,
                profile,
                nowMs,
                timeZone,
                images: Array.isArray(body.images)
                  ? body.images.filter((id): id is string => typeof id === "string" && id.length > 0).slice(0, 6)
                  : [],
                replyId,
              });
              const ctx = packed;
              send({ t: "timing", k: "pack_ms", ms: ctx.packMs });
              send({ t: "timing", k: "db_first_ms", ms: ctx.dbFirstMs });

              let ttftMs: number | null = null;
              let firstAudioMs: number | null = null;
              tVoice = Date.now();
              const primary = resolveVoiceChat(profile.voiceModel, profile.voiceEffort);
              const safety = voiceSafetyPick();
              let sentDone = false;
              const fallback = await runVoiceWithFallback(
                {
                  text,
                  parts: ctx.parts,
                  replyId,
                  voiceSpeed: profile.voiceSpeed,
                  primary,
                  safety,
                  temperature: profile.voiceTemperature,
                  cast: parseCast(profile.voiceCast),
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
              // Her line changed while this answer was being written (the phone heard her go on and sent the whole
              // sentence again, or she edited it), or she went back to an earlier line and this one was taken back:
              // this answer is not kept.
              const now = await getMessage(userMsgId);
              // In a phone round: dropped before his voice started (she went on), or a newer attempt of the same round
              // already wrote its answer. Either way she never hears this one.
              const superseded =
                (Boolean(now) && !String(now?.text ?? "").endsWith(text.trim())) ||
                (round && (gone || (await newerAttempt(replyId, nowMs)))) ||
                (await messageForgotten(userMsgId).catch(() => false));
              if (superseded) {
                await appendBrainLog({ step: "talk-superseded", ok: true, route: "voice", note: "她的这一句后来变了（接着说了或改了），这条回复不保存" }).catch(() => undefined);
              }
              if (display && !superseded) {
                await upsertMessage({
                  id: replyId,
                  role: "assistant",
                  text: display,
                  meta: { replyTo: userMsgId },
                  createdAt: Number.isFinite(replyAt) && replyAt > 0 ? replyAt : userCreatedAt + 1,
                  timeZone,
                  attemptAt: round ? nowMs : undefined,
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
                paidBy: streamResult.paidBy,
                finishReason: streamResult.finishReason,
                effort: streamResult.effort == null ? null : String(streamResult.effort),
                personaMissing: resolved.personaMissing,
                note: formatVoiceLogNote({
                  attempts: fallback.attempts,
                  usedStrip: fallback.usedStrip,
                  chars: ctx.inputChars,
                  failed,
                  failMessage: fallback.failMessage,
                  modelFallback: fallback.modelFallback,
                  injectLine: formatVoiceInjectLine(ctx.inject),
                }),
              });
              if (!failed && !superseded && streamResult.innerNotes) {
                const { keepInner } = await import("@/lib/lover/brain/memory");
                await keepInner(streamResult.innerNotes, nowMs, timeZone);
              }
              if (profile.brainOn && !failed && display && !superseded) {
                const recalledIds = ctx.recalled.map((m) => m.id);
                await runInBackground(async () => {
                  const [{ markRecalled }, { enqueueMemoryWork }] = await Promise.all([
                    import("@/lib/lover/brain/memory"),
                    import("@/lib/lover/brain/night"),
                  ]);
                  await markRecalled(recalledIds).catch((err) => console.error(err));
                  await enqueueMemoryWork(nowMs).catch((err) => console.error(err));
                  await drainJobs(LONG_DRAIN_MS);
                });
              } else {
                await runInBackground(() => drainJobs(LONG_DRAIN_MS));
              }
              await enqueueReportIfDue(nowMs, timeZone);
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
              try {
                controller.close();
              } catch {
                /* the phone already dropped it */
              }
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
