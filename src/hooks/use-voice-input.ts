import { useCallback, useEffect, useRef, useState } from "react";
import {
  acquireMicFromGesture,
  getSpeechRecognitionCtor,
  isAppleTouch,
  releaseMic,
  pickRecorderMime,
  startRecorder,
  stopRecognition,
  usesBrowserStt,
  type SpeechRecognitionLike,
} from "@/lib/lover/audio";
import { closeAudioContext, watchAudioContext } from "@/lib/lover/audio-session";
import { logCallAudio } from "@/lib/lover/call-audio-log";
import { hearUtterance } from "@/lib/lover/hear";
import { clipSaveBanner, type HeardUtterance } from "@/lib/lover/hearing/heard";
import { getHearingSession, setHearingSession } from "@/lib/lover/hearing/session";
import { recordCuts } from "@/lib/lover/hearing/sense";
import { warmupHearing } from "@/lib/lover/hearing/store";
import { attachPcmTap, peakRms, wavFromTap, type PcmTap } from "@/lib/lover/pcm-tap";
import { sampleProsody, type ProsodyFrame } from "@/lib/lover/prosody";
import { mergeSpeech, pickSpokenAlt } from "@/lib/lover/stt-text";
import { FLOOR_START, holdBar, nextFloor } from "@/lib/lover/vad";
import { isQuotaHint, QUOTA_HINT } from "@/lib/lover/xai-error";
import { nativePrepareHoldToTalk } from "@/lib/lover/native-shell";

export type VoiceInputStatus = "idle" | "recording" | "transcribing";

type Options = {
  lang: string;
  prompt?: string;
};

export function useVoiceInput({ lang, prompt }: Options) {
  const [status, setStatus] = useState<VoiceInputStatus>("idle");
  const [interim, setInterim] = useState("");
  const [level, setLevel] = useState(0);
  const [threshold, setThreshold] = useState(0);
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
  const noiseFloorRef = useRef(0.008);
  const triggerFloorRef = useRef(0.008);
  const speechStartWallRef = useRef(0);

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
    setThreshold(0);
    try {
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    } catch {
      /* ignore */
    }
    recorderRef.current = null;
    releaseMic();
    mediaRef.current = null;
    try {
      if (recRef.current) logCallAudio("rec.abort");
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
    closeAudioContext(analyseRef.current?.ctx ?? null, "hold");
    try {
      analyseRef.current?.source.disconnect();
    } catch {
      /* ignore */
    }
    analyseRef.current = null;
  }, []);

  useEffect(() => () => teardownMedia(), [teardownMedia]);

  const startPulse = useCallback(async (stream: MediaStream) => {
    framesRef.current = [];
    noiseFloorRef.current = FLOOR_START;
    const t0 = performance.now();
    let lastAt = t0;
    const Ctor =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    watchAudioContext(ctx, "hold");
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
      const frame = sampleProsody(
        analyser,
        ctx.sampleRate,
        (performance.now() - t0) / 1000,
        true,
        getHearingSession().sense.voicedClarity,
      );
      framesRef.current.push(frame);
      const now = performance.now();
      noiseFloorRef.current = nextFloor(noiseFloorRef.current, frame.rms, Math.min(100, now - lastAt), true);
      lastAt = now;
      const cuts = recordCuts(getHearingSession().sense);
      const cut = holdBar(noiseFloorRef.current, cuts);
      setLevel(Math.min(1, frame.rms * 8));
      setThreshold(Math.min(1, cut * 8));
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
        nativePrepareHoldToTalk();
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
        logCallAudio("rec.onend");
        if (recordingRef.current && session === sessionRef.current && !isAppleTouch()) {
          try {
            rec.start();
            logCallAudio("rec.start (onend)");
          } catch {
            /* Chrome restarts noisily */
          }
        }
      };
      recRef.current = rec;
      try {
        rec.start();
        logCallAudio("rec.start");
      } catch {
        /* already started */
      }
    }

    recordingRef.current = true;
    speechStartWallRef.current = Date.now();
    triggerFloorRef.current = noiseFloorRef.current;
    setStatus("recording");
    if (getHearingSession().provider === "selfhost") {
      void warmupHearing({ data: { provider: "selfhost" } }).then((result) => {
        if (result.cold) setHearingSession({ coldStartMs: result.latency_ms });
      });
    }
  }, [lang, recorderSupported, speechSupported, startPulse]);

  const stop = useCallback(async (): Promise<HeardUtterance> => {
    const empty: HeardUtterance = { text: "", turnId: "", skipQingran: false };
    if (stopLockRef.current) return empty;
    if (!recordingRef.current && status !== "recording") return empty;
    stopLockRef.current = true;
    recordingRef.current = false;
    setStatus("transcribing");

    const session = sessionRef.current;

    await stopRecognition(recRef.current);
    const liveText = (finalTextRef.current || interimRef.current).trim();
    const frames = framesRef.current.slice();
    const samples = (await pcmTapRef.current?.stop()) ?? new Float32Array(0);
    const sampleRate = analyseRef.current?.ctx.sampleRate ?? 48000;
    const wav = wavFromTap(samples, sampleRate);
    const fallback = wav ? null : await collectRecording(session);
    teardownMedia();

    let heard: HeardUtterance = empty;
    try {
      heard = await hearUtterance({
        wav,
        fallback,
        liveText,
        frames,
        prompt: promptRef.current,
        speech_start: speechStartWallRef.current || Date.now() - 1500,
        endpoint_fired: Date.now(),
        peakRms: peakRms(samples, sampleRate) || frames.reduce((max, frame) => Math.max(max, frame.rms), 0),
        vadFloor: triggerFloorRef.current,
        holdToTalk: true,
        silenceWaitMs: 0,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      setStatus("idle");
      stopLockRef.current = false;
      if (isQuotaHint(message)) setError(QUOTA_HINT);
      else if (getHearingSession().debugHearing) setError(message || "识别失败。");
      else setError("我没听清，再说一遍。");
      return empty;
    }

    setInterim("");
    interimRef.current = "";
    finalTextRef.current = "";
    stopLockRef.current = false;

    if (heard.saveError) setError(clipSaveBanner(heard.saveError));
    if (!heard.text) {
      setStatus("idle");
      if (!getHearingSession().debugHearing) setError("我没听清，再说一遍。");
      return heard;
    }

    if (!heard.saveError) setError(null);
    setStatus("idle");
    return heard;
  }, [status, teardownMedia]);

  const stopRaw = useCallback(async () => {
    if (stopLockRef.current) return null;
    if (!recordingRef.current && status !== "recording") return null;
    stopLockRef.current = true;
    recordingRef.current = false;
    setStatus("idle");
    const session = sessionRef.current;
    await stopRecognition(recRef.current);
    const liveText = (finalTextRef.current || interimRef.current).trim();
    const samples = (await pcmTapRef.current?.stop()) ?? new Float32Array(0);
    const wav = wavFromTap(samples, analyseRef.current?.ctx.sampleRate ?? 48000, 0);
    const fallback = wav ? null : await collectRecording(session);
    teardownMedia();
    setInterim("");
    interimRef.current = "";
    finalTextRef.current = "";
    stopLockRef.current = false;
    return { wav, fallback, liveText };
  }, [status, teardownMedia]);

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
    threshold,
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
