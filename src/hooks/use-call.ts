import { useCallback, useEffect, useRef, useState } from "react";
import {
  blobToBase64,
  acquireMicFromGesture,
  createAudioContext,
  getSpeechRecognitionCtor,
  isAppleTouch,
  micFailHint,
  releaseMic,
  pickRecorderMime,
  resumeOrReplaceContext,
  startRecorder,
  usesBrowserStt,
  type SpeechRecognitionLike,
} from "@/lib/lover/audio";
import {
  audioContextNeedsResume,
  claimListenSession,
  listenAppLifecycle,
  listenAudioSession,
  pageIsHidden,
  resumeAudioContext,
} from "@/lib/lover/audio-session";
import { sampleProsody, type ProsodyFrame } from "@/lib/lover/prosody";
import { keepPlaybackAlive, startCallHold, stopCallHold, unlockPlayback } from "@/lib/lover/playback";
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

type Options = {
  onUtterance: (text: string) => Promise<void>;
  prompt?: string;
};

export function useCall({ onUtterance, prompt }: Options) {
  const [active, setActive] = useState(false);
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

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
  const intervalRef = useRef(0);
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
  const tickRef = useRef<() => void>(() => undefined);

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

  const releaseWakeLock = () => {
    try {
      void wakeLockRef.current?.release();
    } catch {
      /* ignore */
    }
    wakeLockRef.current = null;
  };

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

  const keepAudioSteady = () => {
    if (pageIsHidden()) return;
    keepPlaybackAlive();
    const ctx = ctxRef.current;
    if (ctx && audioContextNeedsResume(ctx.state)) {
      try {
        void ctx.resume();
      } catch {
        /* ignore */
      }
    }
  };

  const teardownMedia = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    if (intervalRef.current) window.clearInterval(intervalRef.current);
    intervalRef.current = 0;
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
    setActive(false);
    setError(null);
    setPhaseBoth("idle");
    stopCallHold();
    teardownMedia();
    releaseWakeLock();
  }, [teardownMedia]);

  const armRecorder = () => {
    const stream = streamRef.current;
    if (!liveRef.current || !stream) return;
    if (recorderRef.current && recorderRef.current.state !== "inactive") return;
    recorderRef.current = null;
    chunksRef.current = [];
    const mime = pickRecorderMime();
    const recorder = mime
      ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 128000 })
      : new MediaRecorder(stream);
    recorder.ondataavailable = (ev) => {
      if (deafRef.current) return;
      if (ev.data.size > 0) chunksRef.current.push(ev.data);
      if (phaseRef.current === "listening" && chunksRef.current.length > 8) {
        chunksRef.current = chunksRef.current.slice(-6);
      }
    };
    recorderRef.current = recorder;
    try {
      startRecorder(recorder);
    } catch {
      recorderRef.current = null;
    }
  };

  const beginUtterance = useCallback(() => {
    if (deafRef.current || phaseRef.current !== "listening") return;
    armRecorder();
    if (!streamRef.current || !recorderRef.current) return;
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
      const take = () => {
        const parts = chunksRef.current.filter((b) => b.size > 0);
        chunksRef.current = [];
        resolve(parts.length ? new Blob(parts, { type: mime }) : null);
      };
      if (!recorder || recorder.state === "inactive") {
        take();
        return;
      }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        take();
      };
      const timer = window.setTimeout(finish, 280);
      try {
        recorder.requestData?.();
      } catch {
        window.clearTimeout(timer);
        finish();
        return;
      }
      window.setTimeout(() => {
        window.clearTimeout(timer);
        finish();
      }, 220);
    });
  }, []);

  const abortUtterance = useCallback(() => {
    chunksRef.current = [];
    framesRef.current = [];
    finalTextRef.current = "";
    interimRef.current = "";
    lastTextAtRef.current = 0;
    listenReadyAtRef.current = performance.now() + LISTEN_WARMUP_MS;
    setPhaseBoth("listening");
  }, []);

  const flushUtterance = useCallback(async () => {
    if (phaseRef.current !== "speaking-you") return;
    setPhaseBoth("transcribing");
    deafRef.current = true;
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    const liveText = (finalTextRef.current || interimRef.current).trim();
    const frames = framesRef.current.slice();
    const blob = await collectRecording();
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
      listenReadyAtRef.current = performance.now() + LISTEN_WARMUP_MS;
      setPhaseBoth("listening");
      armRecorder();
      return;
    }
    setError(null);
    setPhaseBoth("listening");
    try {
      await onUtteranceRef.current(heard);
    } catch {
      if (liveRef.current) {
        deafRef.current = false;
        listenReadyAtRef.current = performance.now() + LISTEN_WARMUP_MS;
        setPhaseBoth("listening");
      }
    }
  }, [collectRecording]);

  const listenPulse = useCallback(() => {
    if (!liveRef.current) return;
    const ctx = ctxRef.current;
    const ctxState = ctx?.state as string | undefined;
    if (ctx && audioContextNeedsResume(ctxState ?? "") && !pageIsHidden()) {
      try {
        void ctx.resume();
      } catch {
        /* ignore */
      }
    }
    const analyser = analyserRef.current;
    const now = performance.now();
    if (analyser) {
      const speaking = phaseRef.current === "speaking-you";
      const frame = sampleProsody(
        analyser,
        ctx?.sampleRate ?? 44100,
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
  }, [abortUtterance, beginUtterance, flushUtterance]);

  const tick = useCallback(() => {
    if (!liveRef.current) return;
    listenPulse();
    rafRef.current = requestAnimationFrame(tick);
  }, [listenPulse]);

  tickRef.current = listenPulse;

  const startSpeechRec = (replace = false) => {
    if (pageIsHidden()) return;
    if (!usesBrowserStt()) return;
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    if (recRef.current && !replace) {
      try {
        recRef.current.start();
      } catch {
        /* already started */
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
      if (!liveRef.current || deafRef.current) return;
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
    rec.onerror = () => {
      /* iOS kills recognition in the background; that is not a permission problem */
    };
    rec.onend = () => {
      if (!liveRef.current || deafRef.current) return;
      if (recRef.current !== rec) return;
      if (pageIsHidden()) return;
      window.setTimeout(() => {
        if (!liveRef.current || deafRef.current) return;
        if (recRef.current !== rec) return;
        if (pageIsHidden()) return;
        try {
          rec.start();
        } catch {
          /* leave the recorder running; do not rebuild recognition */
        }
      }, isAppleTouch() ? 160 : 0);
    };
    recRef.current = rec;
    try {
      rec.start();
    } catch {
      window.setTimeout(() => {
        if (!liveRef.current || deafRef.current) return;
        if (recRef.current !== rec) return;
        try {
          rec.start();
        } catch {
          /* ignore */
        }
      }, 180);
    }
  };

  const attachStream = async (stream: MediaStream, fromGesture: boolean) => {
    streamRef.current = stream;
    claimListenSession();
    if (!ctxRef.current || (ctxRef.current.state as string) === "closed") {
      ctxRef.current = fromGesture ? createAudioContext() : await resumeOrReplaceContext(null);
    } else {
      try {
        await resumeAudioContext(ctxRef.current);
      } catch {
        /* ignore */
      }
    }
    if (ctxRef.current) {
      try {
        hookAnalyser(stream, ctxRef.current);
      } catch {
        ctxRef.current = fromGesture ? createAudioContext() : await resumeOrReplaceContext(null);
        if (ctxRef.current) hookAnalyser(stream, ctxRef.current);
      }
    }
  };

  const start = useCallback(async () => {
    if (liveRef.current) return;
    setError(null);
    const pending = acquireMicFromGesture();
    void unlockPlayback();
    ctxRef.current = createAudioContext();
    let stream: MediaStream;
    try {
      stream = await pending;
    } catch (err) {
      teardownMedia();
      setError(micFailHint(err));
      return;
    }
    await attachStream(stream, true);
    liveRef.current = true;
    deafRef.current = false;
    noiseFloorRef.current = 0.008;
    listenReadyAtRef.current = performance.now() + LISTEN_WARMUP_MS;
    setActive(true);
    setPhaseBoth("listening");
    startSpeechRec(true);
    armRecorder();
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
    if (intervalRef.current) window.clearInterval(intervalRef.current);
    intervalRef.current = window.setInterval(() => {
      if (liveRef.current) tickRef.current();
    }, 80);
    startCallHold();
    try {
      wakeLockRef.current = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {
      /* ignore */
    }
  }, [teardownMedia, tick]);

  const deafen = useCallback(() => {
    if (!liveRef.current) return;
    deafRef.current = true;
    chunksRef.current = [];
    if (phaseRef.current === "speaking-you") setPhaseBoth("listening");
  }, []);

  const hear = useCallback(() => {
    if (!liveRef.current) return;
    deafRef.current = false;
    setPhaseBoth("listening");
    finalTextRef.current = "";
    interimRef.current = "";
    lastTextAtRef.current = 0;
    listenReadyAtRef.current = performance.now() + 80;
    chunksRef.current = [];
    if (!pageIsHidden()) startSpeechRec(false);
    armRecorder();
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
  }, [tick]);

  useEffect(() => {
    if (!active) return;
    const restoreAfterReturn = () => {
      if (!liveRef.current) return;
      if (pageIsHidden()) return;
      keepAudioSteady();
      armRecorder();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(tick);
    };
    const stopLife = listenAppLifecycle({
      onForeground: restoreAfterReturn,
    });
    const stopSession = listenAudioSession({
      onActive: restoreAfterReturn,
    });
    return () => {
      stopLife();
      stopSession();
    };
  }, [active, tick]);

  useEffect(() => () => hangup(), [hangup]);

  return {
    active,
    phase,
    level,
    error,
    start,
    hangup,
    deafen,
    hear,
  };
}
