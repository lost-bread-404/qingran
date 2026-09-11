import { useCallback, useEffect, useRef, useState } from "react";
import {
  blobToBase64,
  acquireMic,
  currentMic,
  getSpeechRecognitionCtor,
  isAppleTouch,
  micFailHint,
  micUsable,
  onMicEvent,
  releaseMic,
  pickRecorderMime,
  resumeOrReplaceContext,
  setMicEnabled,
  startRecorder,
  usesBrowserStt,
  type SpeechRecognitionLike,
} from "@/lib/lover/audio";
import {
  audioSessionIsInterrupted,
  isInterruptedState,
  listenAppLifecycle,
  listenAudioSession,
  pageIsHidden,
  setAudioSessionKind,
} from "@/lib/lover/audio-session";
import { sampleProsody, type ProsodyFrame } from "@/lib/lover/prosody";
import { transcribeVoice } from "@/lib/lover/server";
import { finishHeard, mergeSpeech, pickSpokenAlt } from "@/lib/lover/stt-text";
import {
  LISTEN_WARMUP_MS,
  isHoldVoiced,
  isSpeechStart,
  nextFloor,
  shouldEndUtterance,
  VOICE_SPIKE_MS,
} from "@/lib/lover/vad";

export type CallPhase = "idle" | "listening" | "speaking-you" | "transcribing";

const FFT_SIZE = 2048;
const REVIVE_GAPS = [80, 280, 800];
const SLEEP_YIELD_MS = 90_000;
const BACKGROUND_YIELD_MS = 3_000;

type Options = {
  onUtterance: (text: string) => Promise<void>;
  prompt?: string;
};

export function useCall({ onUtterance, prompt }: Options) {
  const [active, setActive] = useState(false);
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [needsTap, setNeedsTap] = useState(false);
  const [resting, setResting] = useState(false);
  const [interrupted, setInterrupted] = useState(false);

  const liveRef = useRef(false);
  const deafRef = useRef(true);
  const phaseRef = useRef<CallPhase>("idle");
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const speechStartRef = useRef(0);
  const lastVoiceRef = useRef(0);
  const voiceBurstAtRef = useRef(0);
  const lastTextAtRef = useRef(0);
  const listenReadyAtRef = useRef(0);
  const rafRef = useRef(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const onUtteranceRef = useRef(onUtterance);
  const promptRef = useRef(prompt ?? "");
  const noiseFloorRef = useRef(0.008);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const finalTextRef = useRef("");
  const interimRef = useRef("");
  const framesRef = useRef<ProsodyFrame[]>([]);
  const pitchTickRef = useRef(0);
  const revivingRef = useRef(false);
  const tickRef = useRef<() => void>(() => undefined);
  const fromBackgroundRef = useRef(false);
  const interruptedRef = useRef(false);
  const restingRef = useRef(false);
  const restTimerRef = useRef(0);
  const bgYieldTimerRef = useRef(0);

  useEffect(() => {
    onUtteranceRef.current = onUtterance;
  }, [onUtterance]);
  useEffect(() => {
    promptRef.current = prompt ?? "";
  }, [prompt]);

  const setPhaseBoth = (next: CallPhase) => {
    phaseRef.current = next;
    setPhase(next);
  };

  const clearTimers = () => {
    if (restTimerRef.current) window.clearTimeout(restTimerRef.current);
    if (bgYieldTimerRef.current) window.clearTimeout(bgYieldTimerRef.current);
    restTimerRef.current = 0;
    bgYieldTimerRef.current = 0;
  };

  const releaseWakeLock = () => {
    try {
      void wakeLockRef.current?.release();
    } catch {
      /* ignore */
    }
    wakeLockRef.current = null;
  };

  const teardownMedia = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    try {
      sourceRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    sourceRef.current = null;
    analyserRef.current = null;
    try {
      recorderRef.current?.state === "recording" && recorderRef.current.stop();
    } catch {
      /* ignore */
    }
    recorderRef.current = null;
    chunksRef.current = [];
    const rec = recRef.current;
    recRef.current = null;
    try {
      rec?.abort();
    } catch {
      /* ignore */
    }
    releaseMic();
    streamRef.current = null;
    try {
      void ctxRef.current?.close();
    } catch {
      /* ignore */
    }
    ctxRef.current = null;
    finalTextRef.current = "";
    interimRef.current = "";
    setLevel(0);
  }, []);

  const hangup = useCallback(() => {
    liveRef.current = false;
    deafRef.current = true;
    restingRef.current = false;
    interruptedRef.current = false;
    clearTimers();
    setActive(false);
    setNeedsTap(false);
    setResting(false);
    setInterrupted(false);
    setPhaseBoth("idle");
    teardownMedia();
    releaseWakeLock();
  }, [teardownMedia]);

  const beginUtterance = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || recorderRef.current) return;
    if (restTimerRef.current) window.clearTimeout(restTimerRef.current);
    restTimerRef.current = 0;
    chunksRef.current = [];
    const mime = pickRecorderMime();
    const recorder = mime
      ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 128000 })
      : new MediaRecorder(stream);
    recorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) chunksRef.current.push(ev.data);
    };
    recorderRef.current = recorder;
    try {
      startRecorder(recorder);
    } catch {
      recorderRef.current = null;
      return;
    }
    const now = performance.now();
    speechStartRef.current = now;
    lastVoiceRef.current = now;
    voiceBurstAtRef.current = now;
    if (!lastTextAtRef.current || now - lastTextAtRef.current > 400) {
      finalTextRef.current = "";
      interimRef.current = "";
      lastTextAtRef.current = 0;
    }
    framesRef.current = [];
    pitchTickRef.current = 0;
    setPhaseBoth("speaking-you");
  }, []);

  const collectRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    const mime = recorder?.mimeType || pickRecorderMime() || "audio/webm";
    return new Promise<Blob | null>((resolve) => {
      if (!recorder || recorder.state === "inactive") {
        const parts = chunksRef.current.filter((b) => b.size > 0);
        resolve(parts.length ? new Blob(parts, { type: mime }) : null);
        return;
      }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        const parts = chunksRef.current.filter((b) => b.size > 0);
        resolve(parts.length ? new Blob(parts, { type: mime }) : null);
      };
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
  }, []);

  const abortUtterance = useCallback(() => {
    try {
      recorderRef.current?.state === "recording" && recorderRef.current.stop();
    } catch {
      /* ignore */
    }
    recorderRef.current = null;
    chunksRef.current = [];
    framesRef.current = [];
    finalTextRef.current = "";
    interimRef.current = "";
    lastTextAtRef.current = 0;
    listenReadyAtRef.current = performance.now() + LISTEN_WARMUP_MS;
    setPhaseBoth("listening");
    armRestTimer();
  }, []);

  const flushUtterance = useCallback(async () => {
    if (phaseRef.current !== "speaking-you") return;
    setPhaseBoth("transcribing");
    deafRef.current = true;
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    const liveText = (finalTextRef.current || interimRef.current).trim();
    const frames = framesRef.current.slice();
    const blob = await collectRecording();
    recorderRef.current = null;
    chunksRef.current = [];
    setMicEnabled(streamRef.current, false);
    if (!liveRef.current) return;
    finalTextRef.current = "";
    interimRef.current = "";
    lastTextAtRef.current = 0;

    let heard = "";
    let words: { text?: string; start?: number; end?: number }[] = [];
    if (blob && blob.size >= 40) {
      try {
        const result = await transcribeVoice({
          data: {
            audioBase64: await blobToBase64(blob),
            mimeType: blob.type || "audio/webm",
            prompt: promptRef.current,
          },
        });
        if (result.ok) {
          heard = result.text.trim();
          words = result.words ?? [];
        }
      } catch {
        /* fall through */
      }
    }
    heard = finishHeard(heard, liveText, words, frames);
    if (!liveRef.current) return;
    if (!heard) {
      setError("我没听清，再说一遍。");
      deafRef.current = false;
      setMicEnabled(streamRef.current, true);
      listenReadyAtRef.current = performance.now() + LISTEN_WARMUP_MS;
      setPhaseBoth("listening");
      armRestTimer();
      return;
    }
    setError(null);
    setPhaseBoth("listening");
    try {
      await onUtteranceRef.current(heard);
    } catch {
      if (liveRef.current) {
        deafRef.current = false;
        setMicEnabled(streamRef.current, true);
        listenReadyAtRef.current = performance.now() + LISTEN_WARMUP_MS;
        setPhaseBoth("listening");
        armRestTimer();
      }
    }
  }, [collectRecording]);

  const dropCapture = (kind: "speak" | "yield") => {
    const rec = recRef.current;
    recRef.current = null;
    try {
      rec?.abort();
    } catch {
      /* ignore */
    }
    try {
      sourceRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    sourceRef.current = null;
    analyserRef.current = null;
    try {
      recorderRef.current?.state === "recording" && recorderRef.current.stop();
    } catch {
      /* ignore */
    }
    recorderRef.current = null;
    chunksRef.current = [];
    releaseMic();
    streamRef.current = null;
    try {
      void ctxRef.current?.close();
    } catch {
      /* ignore */
    }
    ctxRef.current = null;
    setAudioSessionKind(kind);
    setLevel(0);
    if (kind === "yield") releaseWakeLock();
  };

  const enterRest = () => {
    if (!liveRef.current || restingRef.current) return;
    restingRef.current = true;
    setResting(true);
    dropCapture("yield");
  };

  const armRestTimer = () => {
    if (restTimerRef.current) window.clearTimeout(restTimerRef.current);
    restTimerRef.current = 0;
    if (!liveRef.current || restingRef.current || interruptedRef.current || deafRef.current) return;
    restTimerRef.current = window.setTimeout(() => {
      restTimerRef.current = 0;
      if (!liveRef.current || restingRef.current || interruptedRef.current || deafRef.current) return;
      if (phaseRef.current !== "listening") return;
      enterRest();
    }, SLEEP_YIELD_MS);
  };

  const markInterrupted = () => {
    if (!liveRef.current) return;
    interruptedRef.current = true;
    setInterrupted(true);
    setNeedsTap(true);
    dropCapture("yield");
  };

  const tick = useCallback(() => {
    if (!liveRef.current) return;
    if (restingRef.current || interruptedRef.current || pageIsHidden()) {
      rafRef.current = requestAnimationFrame(tick);
      return;
    }
    const ctxState = ctxRef.current?.state as string | undefined;
    if (isInterruptedState(ctxState)) {
      markInterrupted();
      rafRef.current = requestAnimationFrame(tick);
      return;
    }
    const analyser = analyserRef.current;
    const now = performance.now();
    if (analyser) {
      const speaking = phaseRef.current === "speaking-you";
      const frame = sampleProsody(
        analyser,
        ctxRef.current?.sampleRate ?? 44100,
        (now - speechStartRef.current) / 1000,
        pitchTickRef.current % 2 === 0,
      );
      if (speaking) {
        pitchTickRef.current += 1;
        framesRef.current.push(frame);
      }
      const rms = frame.rms;
      noiseFloorRef.current = nextFloor(noiseFloorRef.current, rms, speaking);
      const floor = noiseFloorRef.current;
      const rising = isSpeechStart(rms, floor, frame.clarity, frame.bright);
      setLevel(Math.min(1, rms * 8));
      if (
        !deafRef.current &&
        !restingRef.current &&
        !interruptedRef.current &&
        phaseRef.current === "listening" &&
        now >= listenReadyAtRef.current &&
        rising
      ) {
        beginUtterance();
      } else if (speaking) {
        const voiced = isHoldVoiced(rms, floor);
        if (voiced) {
          if (!voiceBurstAtRef.current) voiceBurstAtRef.current = now;
          if (now - voiceBurstAtRef.current >= VOICE_SPIKE_MS) lastVoiceRef.current = now;
        } else {
          voiceBurstAtRef.current = 0;
        }
        const hasText = Boolean((finalTextRef.current || interimRef.current).trim());
        if (
          shouldEndUtterance({
            now,
            startAt: speechStartRef.current,
            lastVoiceAt: lastVoiceRef.current,
            voiced,
            hasText,
            lastTextAt: lastTextAtRef.current,
          })
        ) {
          const spoken = now - speechStartRef.current;
          if (!hasText && spoken < 500) abortUtterance();
          else void flushUtterance();
        }
      }
    } else if (phaseRef.current === "speaking-you") {
      shouldEndUtterance({
        now,
        startAt: speechStartRef.current,
        lastVoiceAt: lastVoiceRef.current,
        voiced: false,
        hasText: Boolean((finalTextRef.current || interimRef.current).trim()),
        lastTextAt: lastTextAtRef.current,
      }) && void flushUtterance();
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [abortUtterance, beginUtterance, flushUtterance]);

  tickRef.current = tick;

  const hookAnalyser = (stream: MediaStream, ctx: AudioContext) => {
    try {
      sourceRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0.35;
    source.connect(analyser);
    sourceRef.current = source;
    analyserRef.current = analyser;
  };

  const startSpeechRec = (replace = false) => {
    if (!usesBrowserStt()) return;
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    if (recRef.current && !replace) {
      try {
        recRef.current.start();
      } catch {
        /* already started, or the instance died */
      }
      return;
    }
    try {
      recRef.current?.abort();
    } catch {
      /* ignore */
    }
    recRef.current = null;

    const rec = new Ctor();
    rec.lang = "zh-CN";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 3;
    rec.onresult = (ev) => {
      if (!liveRef.current || deafRef.current || restingRef.current || interruptedRef.current) return;
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
      if (addition.trim()) finalTextRef.current = mergeSpeech(finalTextRef.current, addition);
      const committed = finalTextRef.current;
      const shown = live.trim() ? mergeSpeech(committed, live) : committed || live;
      interimRef.current = shown.trim();
      if ((addition || live).trim()) lastTextAtRef.current = performance.now();
    };
    rec.onerror = (ev) => {
      if (ev.error === "not-allowed") {
        setNeedsTap(true);
        setError("点一下，打开麦克风");
      }
    };
    rec.onend = () => {
      if (!liveRef.current || deafRef.current || restingRef.current || interruptedRef.current) return;
      if (recRef.current !== rec) return;
      if (pageIsHidden()) return;
      window.setTimeout(() => {
        if (!liveRef.current || deafRef.current || restingRef.current || interruptedRef.current) return;
        if (recRef.current !== rec) return;
        try {
          rec.start();
        } catch {
          startSpeechRec(true);
        }
      }, isAppleTouch() ? 160 : 0);
    };
    recRef.current = rec;
    try {
      rec.start();
    } catch {
      window.setTimeout(() => {
        if (!liveRef.current || deafRef.current || restingRef.current || interruptedRef.current) return;
        if (recRef.current !== rec) return;
        try {
          rec.start();
        } catch {
          setNeedsTap(true);
        }
      }, 180);
    }
  };

  const mediaHealthy = () => {
    const ctx = ctxRef.current;
    return micUsable(streamRef.current) && Boolean(ctx && ctx.state === "running" && analyserRef.current);
  };

  const reviveOnce = async (opts?: { gesture?: boolean }) => {
    if (!liveRef.current) return false;
    if (pageIsHidden() && !opts?.gesture) return false;
    if (audioSessionIsInterrupted() && !opts?.gesture) return false;

    try {
      ctxRef.current = await resumeOrReplaceContext(ctxRef.current);
    } catch {
      /* ignore */
    }

    let stream = currentMic() || (micUsable(streamRef.current) ? streamRef.current : null);
    const dead = !micUsable(stream);
    const replace =
      dead ||
      restingRef.current ||
      Boolean(!opts?.gesture && isAppleTouch() && fromBackgroundRef.current);
    if (dead || replace) {
      try {
        stream = await acquireMic({ force: true });
      } catch {
        return false;
      }
    }
    if (!stream) return false;
    streamRef.current = stream;
    setAudioSessionKind("listen");

    if (!ctxRef.current || (ctxRef.current.state as string) === "closed") {
      ctxRef.current = await resumeOrReplaceContext(null);
    }
    if (ctxRef.current && stream) {
      try {
        hookAnalyser(stream, ctxRef.current);
      } catch {
        ctxRef.current = await resumeOrReplaceContext(null);
        if (ctxRef.current) {
          try {
            hookAnalyser(stream, ctxRef.current);
          } catch {
            return false;
          }
        }
      }
    }

    if (phaseRef.current === "speaking-you") {
      try {
        recorderRef.current?.state === "recording" && recorderRef.current.stop();
      } catch {
        /* ignore */
      }
      recorderRef.current = null;
      chunksRef.current = [];
      setPhaseBoth("listening");
    }

    if (!deafRef.current) {
      setMicEnabled(streamRef.current, true);
      listenReadyAtRef.current = performance.now() + LISTEN_WARMUP_MS;
      startSpeechRec(replace);
    }
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tickRef.current);
    try {
      wakeLockRef.current = (await navigator.wakeLock?.request("screen")) ?? wakeLockRef.current;
    } catch {
      /* ignore */
    }
    return mediaHealthy();
  };

  const revive = useCallback(async (opts?: { gesture?: boolean }) => {
    if (!liveRef.current) return;
    if (pageIsHidden() && !opts?.gesture) return;
    if (audioSessionIsInterrupted() && !opts?.gesture) return;
    if (revivingRef.current && !opts?.gesture) return;
    revivingRef.current = true;
    try {
      if (!opts?.gesture) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      if (pageIsHidden() && !opts?.gesture) return;
      if (audioSessionIsInterrupted() && !opts?.gesture) return;
      let ok = await reviveOnce(opts);
      if (!opts?.gesture) {
        for (const gap of REVIVE_GAPS) {
          if (!liveRef.current || ok) break;
          if (pageIsHidden() || audioSessionIsInterrupted()) return;
          await new Promise((resolve) => window.setTimeout(resolve, gap));
          if (!liveRef.current) return;
          if (pageIsHidden() || audioSessionIsInterrupted()) return;
          ok = await reviveOnce(opts);
        }
      }
      if (!liveRef.current) return;
      if (ok) {
        fromBackgroundRef.current = false;
        interruptedRef.current = false;
        restingRef.current = false;
        setInterrupted(false);
        setResting(false);
        setNeedsTap(false);
        setError(null);
        armRestTimer();
      } else if (!audioSessionIsInterrupted() && !pageIsHidden()) {
        setNeedsTap(true);
      }
    } finally {
      revivingRef.current = false;
    }
  }, []);

  const start = useCallback(async () => {
    if (liveRef.current) return;
    setError(null);
    setNeedsTap(false);
    setResting(false);
    setInterrupted(false);
    restingRef.current = false;
    interruptedRef.current = false;
    try {
      const stream = await acquireMic();
      streamRef.current = stream;
      const ctx = await resumeOrReplaceContext(null);
      if (ctx) {
        ctxRef.current = ctx;
        hookAnalyser(stream, ctx);
      }
    } catch (err) {
      teardownMedia();
      liveRef.current = false;
      setActive(false);
      setNeedsTap(true);
      setError(micFailHint(err));
      return;
    }
    liveRef.current = true;
    deafRef.current = false;
    noiseFloorRef.current = 0.008;
    listenReadyAtRef.current = performance.now() + LISTEN_WARMUP_MS;
    setActive(true);
    setPhaseBoth("listening");
    startSpeechRec(true);
    rafRef.current = requestAnimationFrame(tick);
    armRestTimer();
    try {
      wakeLockRef.current = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {
      /* ignore */
    }
  }, [teardownMedia, tick]);

  const deafen = useCallback(() => {
    if (!liveRef.current) return;
    deafRef.current = true;
    if (restTimerRef.current) window.clearTimeout(restTimerRef.current);
    restTimerRef.current = 0;
    dropCapture("speak");
    if (phaseRef.current === "speaking-you") {
      setPhaseBoth("listening");
    }
  }, []);

  const hear = useCallback(() => {
    if (!liveRef.current) return;
    if (audioSessionIsInterrupted() || pageIsHidden()) {
      enterRest();
      return;
    }
    deafRef.current = false;
    restingRef.current = false;
    interruptedRef.current = false;
    setResting(false);
    setInterrupted(false);
    setPhaseBoth("listening");
    finalTextRef.current = "";
    interimRef.current = "";
    lastTextAtRef.current = 0;
    listenReadyAtRef.current = performance.now() + LISTEN_WARMUP_MS;
    armRestTimer();
    void revive();
  }, [revive]);

  useEffect(() => {
    if (!active) return;
    const stopMicWatch = onMicEvent((event) => {
      if (!liveRef.current) return;
      if (interruptedRef.current || restingRef.current || pageIsHidden()) return;
      if (event === "ended") void revive();
      if (event === "mute") {
        setMicEnabled(streamRef.current, true);
        if (fromBackgroundRef.current) void revive();
      }
    });
    const stopLife = listenAppLifecycle({
      onForeground: () => {
        if (!liveRef.current) return;
        if (bgYieldTimerRef.current) window.clearTimeout(bgYieldTimerRef.current);
        bgYieldTimerRef.current = 0;
        if (audioSessionIsInterrupted()) {
          interruptedRef.current = true;
          setInterrupted(true);
          setNeedsTap(true);
          return;
        }
        void revive();
      },
      onBackground: () => {
        fromBackgroundRef.current = true;
        if (bgYieldTimerRef.current) window.clearTimeout(bgYieldTimerRef.current);
        bgYieldTimerRef.current = window.setTimeout(() => {
          bgYieldTimerRef.current = 0;
          if (!liveRef.current) return;
          if (!pageIsHidden()) return;
          enterRest();
        }, BACKGROUND_YIELD_MS);
      },
    });
    const stopSession = listenAudioSession({
      onInterrupted: () => {
        markInterrupted();
      },
      onActive: () => {
        if (!liveRef.current) return;
        if (!interruptedRef.current) return;
        if (restingRef.current || pageIsHidden()) return;
        interruptedRef.current = false;
        setInterrupted(false);
        void revive();
      },
    });
    const devices = navigator.mediaDevices;
    const onDevice = () => {
      if (!liveRef.current) return;
      if (interruptedRef.current || restingRef.current || pageIsHidden()) return;
      void revive();
    };
    try {
      devices?.addEventListener?.("devicechange", onDevice);
    } catch {
      /* ignore */
    }
    return () => {
      stopMicWatch();
      stopLife();
      stopSession();
      try {
        devices?.removeEventListener?.("devicechange", onDevice);
      } catch {
        /* ignore */
      }
    };
  }, [active, revive]);

  useEffect(() => () => hangup(), [hangup]);

  return {
    active,
    phase,
    level,
    error,
    needsTap,
    resting,
    interrupted,
    start,
    hangup,
    deafen,
    hear,
    revive,
  };
}
