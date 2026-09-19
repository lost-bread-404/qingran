import { useCallback, useEffect, useRef, useState } from "react";
import {
  acquireMicFromGesture,
  getSpeechRecognitionCtor,
  isAppleTouch,
  pauseMic,
  pickRecorderMime,
  startRecorder,
  stopRecognition,
  usesBrowserStt,
  type SpeechRecognitionLike,
} from "@/lib/lover/audio";
import { hearUtterance } from "@/lib/lover/hear";
import { getHearingSession, setHearingSession } from "@/lib/lover/hearing/session";
import { clipSaveBanner } from "@/lib/lover/hearing/scripted";
import { warmupHearing } from "@/lib/lover/hearing/store";
import { attachPcmTap, wavFromTap, type PcmTap } from "@/lib/lover/pcm-tap";
import { sampleProsody, type ProsodyFrame } from "@/lib/lover/prosody";
import { mergeSpeech, pickSpokenAlt } from "@/lib/lover/stt-text";
import { isQuotaHint, QUOTA_HINT } from "@/lib/lover/xai-error";

export type VoiceInputStatus = "idle" | "recording" | "transcribing";

type Options = {
  lang: string;
  prompt?: string;
};

export function useVoiceInput({ lang, prompt }: Options) {
  const [status, setStatus] = useState<VoiceInputStatus>("idle");
  const [interim, setInterim] = useState("");
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [micReady, setMicReady] = useState<boolean | null>(null);

  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const mediaRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const rafRef = useRef<number>(0);
  const recordingRef = useRef(false);
  const finalTextRef = useRef("");
  const interimRef = useRef("");
  const stopLockRef = useRef(false);
  const sessionRef = useRef(0);
  const promptRef = useRef(prompt ?? "");
  const framesRef = useRef<ProsodyFrame[]>([]);
  const analyseRef = useRef<{ ctx: AudioContext; source: MediaStreamAudioSourceNode } | null>(null);
  const pcmTapRef = useRef<PcmTap | null>(null);

  const speechSupported = usesBrowserStt();
  const recorderSupported =
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia);

  useEffect(() => {
    promptRef.current = prompt ?? "";
  }, [prompt]);

  const teardownMedia = useCallback(() => {
    recordingRef.current = false;
    sessionRef.current += 1;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    setLevel(0);
    try {
      recorderRef.current?.state === "recording" && recorderRef.current.stop();
    } catch {
      /* ignore */
    }
    recorderRef.current = null;
    pauseMic();
    try {
      recRef.current?.abort();
    } catch {
      /* ignore */
    }
    recRef.current = null;
    try {
      pcmTapRef.current?.dispose();
    } catch {
      /* ignore */
    }
    pcmTapRef.current = null;
    try {
      analyseRef.current?.source.disconnect();
      void analyseRef.current?.ctx.close();
    } catch {
      /* ignore */
    }
    analyseRef.current = null;
  }, []);

  useEffect(() => () => teardownMedia(), [teardownMedia]);

  const startPulse = useCallback(async (stream: MediaStream) => {
    framesRef.current = [];
    const t0 = performance.now();
    const Ctor =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.2;
    source.connect(analyser);
    analyseRef.current = { ctx, source };
    try {
      const tap = await attachPcmTap(ctx, source);
      pcmTapRef.current = tap;
      tap.start();
    } catch {
      pcmTapRef.current = null;
    }
    const tick = () => {
      const frame = sampleProsody(analyser, ctx.sampleRate, (performance.now() - t0) / 1000, true);
      framesRef.current.push(frame);
      setLevel(Math.min(1, frame.rms * 8));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const start = useCallback(async () => {
    if (recordingRef.current || stopLockRef.current) return;
    const session = ++sessionRef.current;
    setError(null);
    setInterim("");
    interimRef.current = "";
    finalTextRef.current = "";
    chunksRef.current = [];

    if (!recorderSupported && !speechSupported) {
      setMicReady(false);
      setError("这个浏览器没有麦克风能力，先打字吧。");
      return;
    }

    try {
      if (recorderSupported) {
        const stream = await acquireMicFromGesture();
        if (session !== sessionRef.current) return;
        mediaRef.current = stream;
        setMicReady(true);
        await startPulse(stream);

        const mime = pickRecorderMime();
        const recorder = mime
          ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 128000 })
          : new MediaRecorder(stream);
        recorderRef.current = recorder;
        recorder.ondataavailable = (ev) => {
          if (session !== sessionRef.current) return;
          if (ev.data.size > 0) chunksRef.current.push(ev.data);
        };
        startRecorder(recorder);
      }
    } catch {
      setMicReady(false);
      setError("麦克风被关掉了。打开权限，或先打字。");
      return;
    }

    const Ctor = speechSupported ? getSpeechRecognitionCtor() : null;
    if (Ctor) {
      const rec = new Ctor();
      rec.lang = lang.startsWith("en") ? "en-US" : "zh-CN";
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 3;
      rec.onresult = (ev) => {
        if (session !== sessionRef.current) return;
        let addition = "";
        let live = "";
        for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
          const piece = ev.results[i];
          if (!piece) continue;
          const alts: string[] = [];
          for (let n = 0; n < piece.length; n += 1) alts.push(piece[n]?.transcript ?? "");
          const alt = pickSpokenAlt(alts);
          if (piece.isFinal) addition += alt;
          else live += alt;
        }
        const next = addition.trim();
        if (next) finalTextRef.current = mergeSpeech(finalTextRef.current, next);
        const committed = finalTextRef.current;
        const shown = live ? mergeSpeech(committed, live) : committed;
        interimRef.current = shown.trim();
        setInterim(interimRef.current);
      };
      rec.onerror = (ev) => {
        if (ev.error === "not-allowed") {
          setMicReady(false);
          setError("麦克风被关掉了。");
        }
      };
      rec.onend = () => {
        if (recordingRef.current && session === sessionRef.current && !isAppleTouch()) {
          try {
            rec.start();
          } catch {
            /* Chrome restarts noisily */
          }
        }
      };
      recRef.current = rec;
      try {
        rec.start();
      } catch {
        /* already started */
      }
    }

    recordingRef.current = true;
    setStatus("recording");
    if (getHearingSession().provider === "selfhost") {
      void warmupHearing({ data: { provider: "selfhost" } }).then((result) => {
        if (result.cold) setHearingSession({ coldStartMs: result.latency_ms });
      });
    }
  }, [lang, recorderSupported, speechSupported, startPulse]);

  const collectClip = useCallback(async () => {
    if (stopLockRef.current) return null;
    if (!recordingRef.current && status !== "recording") return null;
    stopLockRef.current = true;
    recordingRef.current = false;
    setStatus("transcribing");

    const session = sessionRef.current;

    await stopRecognition(recRef.current);
    const liveText = (finalTextRef.current || interimRef.current).trim();
    const frames = framesRef.current.slice();
    const samples = (await pcmTapRef.current?.stop()) ?? new Float32Array(0);
    const wav = wavFromTap(samples, analyseRef.current?.ctx.sampleRate ?? 48000);
    const fallback = wav ? null : await collectRecording(session);
    teardownMedia();
    setInterim("");
    interimRef.current = "";
    finalTextRef.current = "";
    return { wav, fallback, liveText, frames };
  }, [status, teardownMedia]);

  const stop = useCallback(async (): Promise<string> => {
    const collected = await collectClip();
    if (!collected) return "";

    let heard = "";
    let saveError: string | undefined;
    try {
      const result = await hearUtterance({
        wav: collected.wav,
        fallback: collected.fallback,
        liveText: collected.liveText,
        frames: collected.frames,
        prompt: promptRef.current,
        speech_start: Date.now() - 1500,
        endpoint_fired: Date.now(),
      });
      heard = result.text ?? "";
      saveError = result.saveError;
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      setStatus("idle");
      stopLockRef.current = false;
      setError(isQuotaHint(message) ? QUOTA_HINT : "我没听清，再说一遍。");
      return "";
    }

    stopLockRef.current = false;

    const session = getHearingSession();
    if (saveError && (session.capture || session.scripted)) {
      setStatus("idle");
      setError(clipSaveBanner(saveError));
      return heard;
    }

    if (!heard) {
      setStatus("idle");
      setError("我没听清，再说一遍。");
      return "";
    }

    setStatus("idle");
    return heard;
  }, [collectClip]);

  const stopRaw = useCallback(async () => {
    const collected = await collectClip();
    stopLockRef.current = false;
    setStatus("idle");
    return collected;
  }, [collectClip]);

  const cancel = useCallback(() => {
    stopLockRef.current = false;
    teardownMedia();
    setInterim("");
    setStatus("idle");
  }, [teardownMedia]);

  async function collectRecording(session: number): Promise<Blob | null> {
    const recorder = recorderRef.current;
    const mime = recorder?.mimeType || pickRecorderMime() || "audio/webm";
    const fromChunks = () => {
      if (session !== sessionRef.current) return null;
      const parts = chunksRef.current.filter((b) => b.size > 0);
      return parts.length ? new Blob(parts, { type: mime }) : null;
    };
    if (!recorder || recorder.state === "inactive") return fromChunks();
    return new Promise((resolve) => {
      const finish = () => resolve(fromChunks());
      const timer = window.setTimeout(finish, 1600);
      recorder.onstop = () => {
        window.clearTimeout(timer);
        finish();
      };
      try {
        recorder.requestData?.();
        recorder.stop();
      } catch {
        window.clearTimeout(timer);
        finish();
      }
    });
  }

  return {
    status,
    interim,
    level,
    error,
    setError,
    micReady,
    speechSupported,
    recorderSupported,
    start,
    stop,
    stopRaw,
    cancel,
  };
}
