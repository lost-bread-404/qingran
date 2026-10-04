import { createFileRoute } from "@tanstack/react-router";
import { assertModelConfig, LONG_DRAIN_MS, resolveVoiceChat, voiceSafetyPick } from "@/lib/lover/brain/config";
import { enqueueReportIfDue } from "@/lib/lover/brain/diary/report";
import { drainJobs } from "@/lib/lover/brain/jobs";
import { runInBackground } from "@/lib/lover/brain/wait-until";
import { upsertMessage, appendBrainLog, getMessage, getProfileData, newerAttempt, messageForgotten, addMessageMeta } from "@/lib/lover/brain/store";
import { modeAfter, setEngineMode, startEngine, type Engine, type Mark } from "@/lib/lover/brain/voice/engine";
import { buildVoiceMessages } from "@/lib/lover/brain/voice/pack-build";
import { runTalkStream, type TalkStreamResult } from "@/lib/lover/stream-talk";
import { parseUsage } from "@/lib/lover/brain/usage";
import { localDay } from "@/lib/lover/brain/time";
import { loadHotContext } from "@/lib/lover/brain/voice/pack";
import { runVoiceWithFallback, formatVoiceLogNote } from "@/lib/lover/brain/voice/voice-fallback";
import { recordVoiceTurn } from "@/lib/lover/brain/voice-log";
import { syncTalkTimeZone } from "@/lib/lover/brain/log-refs";
import { talkRateHit } from "@/lib/lover/brain/spend/rate";
import { parseCookie, sha256Hex } from "@/lib/auth-lite/session";
import { newId } from "@/lib/lover/storage";
import { formatVoiceInjectLine, type Profile } from "@/lib/lover/types";
import { castOf } from "@/lib/lover/cast";
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
        request.signal?.addEventListener("abort", () => {
          gone = true;
        });
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
              const roundIds = new Set<string>([userMsgId]);
              for (const item of round ? body.earlier! : []) {
                const id = String(item?.id || "");
                const said = String(item?.text || "").trim();
                if (id) roundIds.add(id);
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
              const cast = castOf(profile);
              let sentDone = false;
              const forward = (event: TalkStreamEvent) => {
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
              };

              // Who plays her this turn (docs/claude-grok-routing.md). Away too long → back to Claude.
              const herBefore = ctx.parts.history.filter((m) => m.role === "user" && !roundIds.has(m.id) && m.createdAt < userCreatedAt);
              // 设置 → 回复 → Claude 分流 off: Grok plays all of her, no marks, no scenes (as before the routing).
              const routing = profile.claudeRouting;
              const start = routing
                ? await startEngine(herBefore.at(-1)?.createdAt ?? null, nowMs, profile.grokReturnMin)
                : { engine: "grok" as Engine, before: "grok" as Engine, autoReturn: false };
              let mark: Mark | null = null;
              /** Who wrote the reply that is kept. */
              let answeredBy: Engine = start.engine;
              let modeNext: Engine = start.engine;
              if (routing && start.engine === "grok") await addMessageMeta([...roundIds], { scene: "grok" });

              let claudeDone: { result: TalkStreamResult; speech: string; failed: boolean; messages: ReturnType<typeof buildVoiceMessages> } | null = null;
              if (start.engine === "claude") {
                const messages = buildVoiceMessages({ ...ctx.parts, engine: "claude" }, "none");
                let shown = false;
                let said = "";
                let errAfter = false;
                let result: TalkStreamResult | null = null;
                try {
                  result = await runTalkStream(
                    { text, messages, replyId, voiceSpeed: profile.voiceSpeed, failOnEmpty: true, model: profile.claudeModel, effort: profile.claudeEffort, cast, engine: "claude" },
                    (event) => {
                      if (event.t === "text") shown = true;
                      if (event.t === "text_end" || event.t === "done") said = event.speech || said;
                      // Until a word of Claude's is out, nothing else goes to her: a failure here is answered by Grok.
                      if (!shown && (event.t === "err" || event.t === "text_end" || event.t === "done")) return;
                      if (event.t === "err" && !event.tts) errAfter = true;
                      forward(event);
                    },
                  );
                } catch (err) {
                  console.error(err);
                }
                const claudeNote = (what: string) =>
                  recordVoiceTurn({
                    ctx,
                    messages,
                    replyId,
                    display: result?.dropped ? "〔转〕" : "",
                    failed: !result?.dropped,
                    model: profile.claudeModel,
                    usage: parseUsage(result?.usage),
                    totalMs: result?.ms ?? Date.now() - tVoice,
                    ttftMs: null,
                    firstAudioMs: null,
                    userCreatedAt,
                    userMsgId,
                    localDay: localDay(userCreatedAt, timeZone),
                    finishReason: result?.finishReason ?? null,
                    route: { engine: "claude", mark: result?.mark ?? null, modeBefore: start.before, autoReturn: start.autoReturn },
                    note: [what, result?.otherEvents ? `events=${result.otherEvents}` : null].filter(Boolean).join("\n"),
                  }).catch((err) => console.error(err));
                if (result?.dropped || (!shown && (result?.mark === "接" || result?.finishReason === "refusal"))) {
                  // 〔转〕 (or a bare 〔接〕, or Claude declining): dropped like an answer taken back; Grok answers this line.
                  mark = "转";
                  modeNext = "grok";
                  answeredBy = "grok";
                  await addMessageMeta([...roundIds], { scene: "grok" });
                  await claudeNote("〔转〕：这条不显示、不保存，同一句交给 Grok");
                } else if (shown) {
                  claudeDone = {
                    result: result ?? { usage: null, ttftMs: null, firstAudioMs: null, model: profile.claudeModel, effort: null, ttsChars: 0, status: null, finishReason: null, ms: Date.now() - tVoice, chars: 0, otherEvents: "exception" },
                    speech: said.trim(),
                    failed: !result || errAfter || !said.trim(),
                    messages,
                  };
                  mark = result?.mark ?? null;
                  modeNext = modeAfter("claude", mark);
                } else {
                  // Claude failed before a word: Grok answers this turn, the mode stays.
                  answeredBy = "grok";
                  await claudeNote(`Claude 没回上（status=${result?.status ?? "-"} finish_reason=${result?.finishReason ?? "-"}），这一轮改由 Grok 回`);
                }
              }

              const fallback = claudeDone
                ? {
                    result: claudeDone.result,
                    speech: claudeDone.speech,
                    failed: claudeDone.failed,
                    usage: parseUsage(claudeDone.result.usage),
                    messages: claudeDone.messages,
                    attempts: [],
                    usedStrip: "none" as const,
                    failMessage: claudeDone.failed ? "Claude 说到一半断了" : null,
                    modelFallback: null,
                  }
                : await runVoiceWithFallback(
                    {
                      text,
                      // Grok in bed gets its own persona; Grok standing in for a Claude that failed gets the whole one.
                      parts: { ...ctx.parts, engine: "grok", routing: routing && (start.engine === "grok" || mark === "转") },
                      replyId,
                      voiceSpeed: profile.voiceSpeed,
                      primary,
                      safety,
                      temperature: profile.voiceTemperature,
                      cast,
                    },
                    forward,
                  );
              if (routing && !claudeDone && start.engine === "grok") {
                mark = fallback.result.mark ?? null;
                modeNext = modeAfter("grok", mark);
              }
              /** This reply belongs to a stretch Grok plays (folded out of what Claude is given later). */
              const grokScene = routing && (start.engine === "grok" || mark === "转");
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
                  meta: { replyTo: userMsgId, engine: answeredBy, ...(grokScene ? { scene: "grok" as const } : {}) },
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

              // The mode moves only with a reply she keeps (one taken back leaves it where it was).
              const kept = Boolean(display) && !superseded && !failed;
              if (kept && modeNext !== start.engine) await setEngineMode(modeNext);
              const usage = fallback.usage;
              await recordVoiceTurn({
                ctx,
                messages: fallback.messages,
                route: {
                  engine: answeredBy,
                  mark,
                  modeBefore: start.before,
                  modeAfter: kept ? modeNext : start.engine,
                  autoReturn: start.autoReturn,
                },
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
                note: claudeDone
                  ? [claudeDone.failed ? "Claude 说到一半断了" : "Claude 回的", `mark=${mark ?? "无"}`, `finish_reason=${claudeDone.result.finishReason ?? "-"}`, formatVoiceInjectLine(ctx.inject)].join("\n")
                  : formatVoiceLogNote({
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
                await keepInner(streamResult.innerNotes, nowMs, timeZone, grokScene);
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
