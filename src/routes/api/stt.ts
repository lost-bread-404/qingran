import { createFileRoute } from "@tanstack/react-router";
import { appendBrainLog } from "@/lib/lover/brain/store";
import { lastDialogueTurns, stripHearingMarkup } from "@/lib/lover/hearing/context";
import { cutTrace } from "@/lib/lover/hearing/cut-trace";
import { finishHearing } from "@/lib/lover/hearing/finish";
import { phoneHearingInputs } from "@/lib/lover/hearing/phone";
import { formatSenseLine, toneFromSense } from "@/lib/lover/hearing/sense";
import { hearClip } from "@/lib/lover/hearing/store";
import { liftQuietWav, prosodyFromWav, wavDurationMs } from "@/lib/lover/hearing/wav";
import type { SttWord } from "@/lib/lover/hearing/xai";
import { downsampleProsody, framesFromStored, readTone } from "@/lib/lover/prosody";
import { newId } from "@/lib/lover/storage";
import { QUOTA_HINT } from "@/lib/lover/xai-error";

type SttBody = {
  audioBase64?: string;
  mimeType?: string;
  speechStart?: number;
  endpointFired?: number;
  silenceWaitMs?: number;
  vadFloor?: number;
  /** What xAI heard while she spoke (absent when the stream did not work for this line: the clip goes to xAI here). */
  streamText?: string;
  streamWords?: SttWord[];
  /** Apple's recognizer on the phone (absent when it was not available). */
  liveText?: string;
  /** How the phone decided she was done: xAI's turn model, a long pause, or the length cap. */
  endedBy?: string;
};

const ENDED: Record<string, string> = { smart: "说完了", quiet: "停顿", cap: "太长" };

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/**
 * The iPhone shell's call hears here: what xAI heard while she spoke (or xAI on the clip, when the stream did not
 * work), Apple's text from the phone, keyterms, context, sound-based 嗯 / 喘 / 笑 recovery, tone marks and the
 * voice-or-noise gate, the same as the web call, with her saved settings. Returns the text to send to /api/talk,
 * or empty for noise.
 */
export const Route = createFileRoute("/api/stt")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const started = Date.now();
        let body: SttBody;
        try {
          body = (await request.json()) as SttBody;
        } catch {
          return Response.json({ ok: false, error: "先给一段声音。" }, { status: 400 });
        }
        const sent = String(body.audioBase64 ?? "");
        if (sent.length < 120) return Response.json({ ok: true, text: "", skip: true, ms: 0 });
        const audioBase64 = liftQuietWav(sent);
        const mimeType = typeof body.mimeType === "string" && body.mimeType ? body.mimeType : "audio/wav";

        const { profile, turns, context, extraKeyterms } = await phoneHearingInputs();
        const sense = profile.hearingSense;
        // An empty stream is not trusted as "nothing said": the clip goes to xAI once more.
        const streamed =
          typeof body.streamText === "string" && body.streamText.trim()
            ? { text: body.streamText, words: Array.isArray(body.streamWords) ? body.streamWords : [] }
            : undefined;
        const liveText = typeof body.liveText === "string" ? body.liveText.trim() : "";
        const apple = typeof body.liveText === "string";
        const frames = framesFromStored(prosodyFromWav(audioBase64, sense.voicedClarity));
        const tone = toneFromSense(sense);
        const toneReading = readTone(frames, tone);
        const durationMs = wavDurationMs(audioBase64);
        const turnId = newId();
        const endpointFired = num(body.endpointFired);

        const result = await hearClip({
          audioBase64,
          mimeType,
          liveText,
          streamed,
          prompt: profile.systemPrompt,
          provider: "xai",
          capture: profile.debugHearing,
          source: "real",
          turnId,
          speech_start: num(body.speechStart),
          endpoint_fired: endpointFired,
          upload_start: started,
          context: context || undefined,
          extraKeyterms,
          keyterms: profile.sttKeyterms,
          debugHearing: profile.debugHearing,
          silenceWaitMs: num(body.silenceWaitMs),
          mode: "call",
          audioRoute: "unknown",
          vadFloor: num(body.vadFloor),
          liveTextSource: apple ? "apple" : "none",
          contextBefore: lastDialogueTurns(turns),
          systemPrompt: profile.systemPrompt,
          holdToTalk: false,
          prosody: downsampleProsody(frames),
          senseLine: `${formatSenseLine(sense)} · 手机`,
          voicedMin: profile.nightVoicedMin,
          noiseMinMs: profile.nightMinMs,
          voicedClarity: sense.voicedClarity,
          pitchHoldMs: sense.pitchHoldMs,
          toneRise: toneReading.riseRatio,
          toneGlide: toneReading.glide,
          toneFade: toneReading.fade,
          tonePeak: toneReading.peak,
          toneMark: toneReading.mark,
        });
        if (result.quota) return Response.json({ ok: false, error: QUOTA_HINT, ms: Date.now() - started });

        const heard = finishHearing(result, {
          debugHearing: profile.debugHearing,
          turnId,
          provider: "xai",
          liveText,
          frames,
          tone,
          endpointFired,
          durationMs,
          voicedMin: profile.nightVoicedMin,
          minMs: profile.nightMinMs,
          pitchHoldMs: sense.pitchHoldMs,
          clarity: sense.voicedClarity,
        });
        const tagged = heard.text.trim();
        const skip = heard.skipQingran || Boolean(heard.nightNoise) || !tagged;
        const text = skip ? "" : stripHearingMarkup(tagged).trim() || tagged;
        const ms = Date.now() - started;
        await appendBrainLog({
          step: "stt",
          ok: true,
          ms,
          route: "voice",
          note: [
            skip ? "native · noise" : "native",
            streamed ? "边说边听" : "整段",
            apple ? (liveText ? "苹果" : "苹果没听到") : "",
            ENDED[String(body.endedBy)] ?? "",
            cutTrace(sent, sense, num(body.vadFloor), num(body.silenceWaitMs) ?? sense.endWaitMs),
          ]
            .filter(Boolean)
            .join(" · "),
          outputText: (text || result.xaiText || "").slice(0, 500),
          error: null,
        }).catch(() => undefined);
        return Response.json({ ok: true, text, skip, turnId, ms });
      },
    },
  },
});
