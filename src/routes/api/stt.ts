import { createFileRoute } from "@tanstack/react-router";
import { appendBrainLog, getProfileData, listHistoryWindow } from "@/lib/lover/brain/store";
import {
  buildHearingContext,
  extractContextKeyterms,
  lastDialogueTurns,
  mergeKeyterms,
  stripHearingMarkup,
  type ContextTurn,
} from "@/lib/lover/hearing/context";
import { finishHearing } from "@/lib/lover/hearing/finish";
import { extractTfIdfTerms } from "@/lib/lover/hearing/keyterms";
import { formatSenseLine, toneFromSense } from "@/lib/lover/hearing/sense";
import { hearClip } from "@/lib/lover/hearing/store";
import { prosodyFromWav, wavDurationMs } from "@/lib/lover/hearing/wav";
import { downsampleProsody, framesFromStored, readTone } from "@/lib/lover/prosody";
import { newId } from "@/lib/lover/storage";
import { lockedProfile } from "@/lib/lover/types";
import { QUOTA_HINT } from "@/lib/lover/xai-error";

type SttBody = {
  audioBase64?: string;
  mimeType?: string;
  speechStart?: number;
  endpointFired?: number;
  silenceWaitMs?: number;
  vadFloor?: number;
};

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/**
 * The iPhone shell's call hears here: the same xAI transcription, keyterms, context,
 * sound-based 嗯 / 喘 / 笑 recovery, tone marks and voice-or-noise gate as the web call,
 * with her saved settings. Returns the text to send to /api/talk, or empty for noise.
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
        const audioBase64 = String(body.audioBase64 ?? "");
        if (audioBase64.length < 120) return Response.json({ ok: true, text: "", skip: true, ms: 0 });
        const mimeType = typeof body.mimeType === "string" && body.mimeType ? body.mimeType : "audio/wav";

        const [savedProfile, recent] = await Promise.all([getProfileData(), listHistoryWindow(null, 24)]);
        const profile = lockedProfile(savedProfile);
        const sense = profile.hearingSense;
        const turns: ContextTurn[] = recent
          .filter((m) => m.kind === "say" || m.kind === "proactive")
          .map((m) => ({ role: m.role, text: m.text.replace(/^⟦回:[^⟧]*⟧/, "") }));
        const context = buildHearingContext(turns);
        const extraKeyterms = mergeKeyterms(
          extractTfIdfTerms([{ text: profile.systemPrompt }], 50),
          extractContextKeyterms(context, 50),
        );
        const frames = framesFromStored(prosodyFromWav(audioBase64, sense.voicedClarity));
        const tone = toneFromSense(sense);
        const toneReading = readTone(frames, tone);
        const durationMs = wavDurationMs(audioBase64);
        const turnId = newId();
        const endpointFired = num(body.endpointFired);

        const result = await hearClip({
          audioBase64,
          mimeType,
          liveText: "",
          prompt: profile.systemPrompt,
          provider: "xai",
          capture: profile.debugHearing,
          source: "real",
          turnId,
          speech_start: num(body.speechStart),
          endpoint_fired: endpointFired,
          upload_start: started,
          context: context || undefined,
          nbest: profile.hearingNbest,
          extraKeyterms,
          keyterms: profile.sttKeyterms,
          debugHearing: profile.debugHearing,
          silenceWaitMs: num(body.silenceWaitMs),
          mode: "call",
          audioRoute: "unknown",
          vadFloor: num(body.vadFloor),
          liveTextSource: "none",
          contextBefore: lastDialogueTurns(turns),
          systemPrompt: profile.systemPrompt,
          holdToTalk: false,
          prosody: downsampleProsody(frames),
          senseLine: `${formatSenseLine(sense)} · 手机`,
          hearingInstruction: profile.hearingInstruction,
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
          liveText: "",
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
          note: skip ? "native · noise" : "native",
          outputText: (text || result.xaiText || "").slice(0, 500),
          error: null,
        }).catch(() => undefined);
        return Response.json({ ok: true, text, skip, turnId, ms });
      },
    },
  },
});
