import { useCallback, useEffect, useRef, useState } from "react";
import {
  acquireMic,
  acquireMicFromGesture,
  currentMic,
  getSpeechRecognitionCtor,
  isAppleTouch,
  micFailHint,
  micUsable,
  releaseMic,
  pickRecorderMime,
  setMicEnabled,
  startRecorder,
  usesBrowserStt,
  type SpeechRecognitionLike,
} from "@/lib/lover/audio";
import {
  closeAudioContext,
  listenAppLifecycle,
  listenAudioSession,
  pageIsHidden,
  watchAudioContext,
} from "@/lib/lover/audio-session";
import { hearUtterance } from "@/lib/lover/hear";
import { clipSaveBanner, type HeardUtterance } from "@/lib/lover/hearing/heard";
import { logCallAudio } from "@/lib/lover/call-audio-log";
import { callListenStuck, CALL_STUCK_MS } from "@/lib/lover/call-phase";
import { getHearingSession } from "@/lib/lover/hearing/session";
import { recordCuts } from "@/lib/lover/hearing/sense";
import {
  listenNativeHangup,
  nativeCallPlan,
  nativeEndCall,
  nativeKeepAwake,
  nativeStartCall,
  type NativeCallParams,
} from "@/lib/lover/native-shell";
import { attachPcmTap, peakRms, peakTimedRms, PRE_ROLL_SEC, pushTimedRms, wavFromTap, type PcmTap, type TimedRms } from "@/lib/lover/pcm-tap";
import { keepPlaybackAlive, isPlaybackActive, startCallHold, stopCallHold, unlockPlayback } from "@/lib/lover/playback";
import { sampleProsody, type ProsodyFrame } from "@/lib/lover/prosody";
import { mergeSpeech, pickSpokenAlt } from "@/lib/lover/stt-text";
import { isQuotaHint, QUOTA_HINT } from "@/lib/lover/xai-error";
import {
  LISTEN_WARMUP_MS,
  CALL_START_WARMUP_MS,
  FLOOR_START,
  POST_QINGRAN_MS,
  floorUpdateAllowed,
  holdBar,
  nextFloor,
  shouldEndUtterance,
  smoothLevel,
  startBar,
  startHoldMs,
} from "@/lib/lover/vad";

export type CallPhase = "idle" | "listening" | "speaking-you" | "transcribing";

const FFT_SIZE = 2048;

/** The iPhone shell runs the same VAD; it gets her numbers when the call starts. */
function nativeCallParams(): NativeCallParams {
  const session = getHearingSession();
  const cuts = recordCuts(session.sense);
  return {
    startMin: cuts.startMin,
    startMult: cuts.startMult,
    holdMin: cuts.holdMin,
    holdMult: cuts.holdMult,
    startHoldMs: startHoldMs(cuts),
    endWaitMs: session.silenceMs,
    maxUtteranceMs: session.sense.maxUtteranceMs,
  };
}

type Options = {
  onUtterance: (heard: HeardUtterance) => Promise<void>;
  prompt?: string;
  isGenerating?: () => boolean;
  isLabeling?: () => boolean;
  onStuck?: (info: { phase: string; deaf: boolean }) => void;
};

export function useCall({ onUtterance, prompt, isGenerating, isLabeling, onStuck }: Options) {
  const [active, setActive] = useState(false);
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [level, setLevel] = useState(0);
  const [threshold, setThreshold] = useState(0);
  const [listenSec, setListenSec] = useState(0);
  const [rmsNow, setRmsNow] = useState(0);
  const [holdNow, setHoldNow] = useState(0);
  const [deaf, setDeaf] = useState(true);
  const [noiseFloor, setNoiseFloor] = useState(FLOOR_START);
  const [error, setError] = useState<string | null>(null);

  const liveRef = useRef(false);
  const deafRef = useRef(true);
  const phaseRef = useRef<CallPhase>("idle");
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const speechStartRef = useRef(0);
  const lastVoiceRef = useRef(0);
  const levelRef = useRef(0);
  const tickAtRef = useRef(0);
  const lastTextAtRef = useRef(0);
  const listenReadyAtRef = useRef(0);
  const speechRiseAtRef = useRef(0);
  const rafRef = useRef(0);
  const intervalRef = useRef(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const pcmTapRef = useRef<PcmTap | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const onUtteranceRef = useRef(onUtterance);
  const promptRef = useRef(prompt ?? "");
  const isGeneratingRef = useRef(isGenerating);
  const isLabelingRef = useRef(isLabeling);
  const onStuckRef = useRef(onStuck);
  const noiseFloorRef = useRef(FLOOR_START);
  const triggerFloorRef = useRef(FLOOR_START);
  const hearAtRef = useRef(0);
  const hearToTriggerRef = useRef<number | null>(null);
  const prerollPeakRef = useRef<number | null>(null);
  const prerollLevelsRef = useRef<TimedRms[]>([]);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const recLiveRef = useRef(false);
  const warmupTimerRef = useRef(0);
  const finalTextRef = useRef("");
  const interimRef = useRef("");
  const framesRef = useRef<ProsodyFrame[]>([]);
  const nativeHangupRef = useRef(false);
  const nativeOwnedRef = useRef(false);
  const speechStartWallRef = useRef(0);
  const recognizingRef = useRef(false);
  /** performance.now() when playback last stopped. Infinity while audio is going out. */
  const playbackIdleAtRef = useRef(0);

  isGeneratingRef.current = isGenerating;
  isLabelingRef.current = isLabeling;
  onStuckRef.current = onStuck;

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
  const setDeafBoth = (next: boolean) => {
    deafRef.current = next;
    setDeaf(next);
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
      pcmTapRef.current?.dispose();
    } catch {
      /* ignore */
    }
    pcmTapRef.current = null;
    try {
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    } catch {
      /* ignore */
    }
    recorderRef.current = null;
    chunksRef.current = [];
    releaseMic();
    streamRef.current = null;
    closeAudioContext(ctxRef.current, "call");
    ctxRef.current = null;
    try {
      if (recRef.current) logCallAudio("rec.abort");
      recRef.current?.abort();
    } catch {
      /* ignore */
    }
    recRef.current = null;
    recLiveRef.current = false;
    if (warmupTimerRef.current) window.clearTimeout(warmupTimerRef.current);
    warmupTimerRef.current = 0;
    finalTextRef.current = "";
    interimRef.current = "";
    setLevel(0);
    setThreshold(0);
    setListenSec(0);
    setRmsNow(0);
    setHoldNow(0);
    setNoiseFloor(FLOOR_START);
  }, []);

  const hangup = useCallback(() => {
    liveRef.current = false;
    nativeOwnedRef.current = false;
    setDeafBoth(true);
    setActive(false);
    setPhaseBoth("idle");
    stopCallHold();
    teardownMedia();
    try {
      void wakeLockRef.current?.release();
    } catch {
      /* ignore */
    }
    wakeLockRef.current = null;
    nativeKeepAwake(false);
    if (!nativeHangupRef.current) nativeEndCall();
  }, [teardownMedia]);

  const beginUtterance = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || phaseRef.current === "speaking-you") return;
    chunksRef.current = [];
    pcmTapRef.current?.start();
    const mime = pickRecorderMime();
    try {
      const recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 128000 })
        : new MediaRecorder(stream);
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      recorderRef.current = recorder;
      startRecorder(recorder);
    } catch {
      recorderRef.current = null;
    }
    const now = performance.now();
    speechStartRef.current = now;
    speechStartWallRef.current = Date.now();
    triggerFloorRef.current = noiseFloorRef.current;
    hearToTriggerRef.current = hearAtRef.current ? Math.round(now - hearAtRef.current) : null;
    prerollPeakRef.current = peakTimedRms(prerollLevelsRef.current);
    lastVoiceRef.current = now;
    if (!lastTextAtRef.current || now - lastTextAtRef.current > 400) {
      finalTextRef.current = "";
      interimRef.current = "";
      lastTextAtRef.current = 0;
    }
    framesRef.current = [];
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

  const flushUtterance = useCallback(async () => {
    if (phaseRef.current !== "speaking-you" || !liveRef.current) return;
    const endpoint_fired = Date.now();
    const silenceWaitMs = Math.max(0, Math.round(performance.now() - lastVoiceRef.current));
    setPhaseBoth("transcribing");
    setDeafBoth(true);
    recognizingRef.current = true;
    const leaveTranscribing = () => {
      recognizingRef.current = false;
      if (!liveRef.current) {
        if (phaseRef.current === "transcribing") setPhaseBoth("idle");
        return;
      }
      if (phaseRef.current !== "transcribing") return;
      setDeafBoth(false);
      setMicEnabled(streamRef.current, true);
      listenReadyAtRef.current = performance.now() + LISTEN_WARMUP_MS;
      setPhaseBoth("listening");
    };
    try {
      await new Promise((resolve) => window.setTimeout(resolve, 180));
      const liveText = (finalTextRef.current || interimRef.current).trim();
      const frames = framesRef.current.slice();
      const samples = (await pcmTapRef.current?.stop()) ?? new Float32Array(0);
      const sampleRate = ctxRef.current?.sampleRate ?? 48000;
      const wav = wavFromTap(samples, sampleRate);
      const fallback = wav ? null : await collectRecording();
      if (wav) {
        try {
          if (recorderRef.current?.state === "recording") recorderRef.current.stop();
        } catch {
          /* ignore */
        }
      }
      recorderRef.current = null;
      chunksRef.current = [];
      if (!liveRef.current) return;
      finalTextRef.current = "";
      interimRef.current = "";
      lastTextAtRef.current = 0;

      let heard: HeardUtterance | null = null;
      try {
        heard = await hearUtterance({
          wav,
          fallback,
          liveText,
          frames,
          prompt: promptRef.current,
          speech_start: speechStartWallRef.current,
          endpoint_fired,
          peakRms: peakRms(samples, sampleRate) || frames.reduce((max, frame) => Math.max(max, frame.rms), 0),
          vadFloor: triggerFloorRef.current,
          hearToTriggerMs: hearToTriggerRef.current ?? undefined,
          prerollPeakRms: prerollPeakRef.current ?? undefined,
          silenceWaitMs,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "";
        if (isQuotaHint(message)) {
          setError(QUOTA_HINT);
          return;
        }
      }
      if (!liveRef.current) return;
      if (heard?.saveError) setError(clipSaveBanner(heard.saveError));
      if (!heard?.text) {
        if (!getHearingSession().debugHearing && !heard?.saveError) setError("我没听清，再说一遍。");
        return;
      }
      if (!heard.saveError) setError(null);
      setPhaseBoth("listening");
      try {
        await onUtteranceRef.current(heard);
      } catch {
        if (liveRef.current) {
          setDeafBoth(false);
          setMicEnabled(streamRef.current, true);
          listenReadyAtRef.current = performance.now() + LISTEN_WARMUP_MS;
          setPhaseBoth("listening");
        }
      }
    } finally {
      leaveTranscribing();
    }
  }, [collectRecording]);

  const tick = useCallback(() => {
    if (!liveRef.current) return;
    const analyser = analyserRef.current;
    const now = performance.now();
    const dtMs = tickAtRef.current ? Math.min(100, Math.max(0, now - tickAtRef.current)) : 16;
    tickAtRef.current = now;
    if (analyser) {
      const speaking = phaseRef.current === "speaking-you";
      const session = getHearingSession();
      const frame = sampleProsody(
        analyser,
        ctxRef.current?.sampleRate ?? 44100,
        (now - speechStartRef.current) / 1000,
        true,
        session.sense.voicedClarity,
        speaking ? 0 : 0.008,
      );
      if (speaking) {
        framesRef.current.push(frame);
      }
      const cuts = recordCuts(session.sense);
      const level = smoothLevel(levelRef.current, frame.rms, dtMs);
      levelRef.current = level;
      pushTimedRms(prerollLevelsRef.current, { t: now, rms: frame.rms }, PRE_ROLL_SEC * 1000);
      const playingBack = isPlaybackActive();
      if (playingBack) playbackIdleAtRef.current = Number.POSITIVE_INFINITY;
      else if (!Number.isFinite(playbackIdleAtRef.current)) playbackIdleAtRef.current = now;
      const msSincePlayback = Number.isFinite(playbackIdleAtRef.current) ? now - playbackIdleAtRef.current : 0;
      const statusAt = session.floorQuietAt;
      const statusSpeaking = !Number.isFinite(statusAt);
      const msSinceStatusQuiet = statusSpeaking ? 0 : now - statusAt;
      if (
        floorUpdateAllowed({
          playbackActive: playingBack,
          msSincePlayback,
          qingranStatusSpeaking: statusSpeaking,
          msSinceStatusQuiet,
        })
      ) {
        noiseFloorRef.current = nextFloor(noiseFloorRef.current, level, dtMs, speaking);
      }
      const floor = noiseFloorRef.current;
      const cut = speaking ? holdBar(floor, cuts) : startBar(floor, cuts);
      setLevel(Math.min(1, level * 8));
      setThreshold(Math.min(1, cut * 8));
      setNoiseFloor(floor);
      if (speaking) {
        setListenSec(Math.max(0, Math.floor((now - speechStartRef.current) / 1000)));
        setRmsNow(level);
        setHoldNow(cut);
      } else {
        setListenSec(0);
      }
      if (deafRef.current || phaseRef.current !== "listening" || now < listenReadyAtRef.current) {
        speechRiseAtRef.current = 0;
      } else if (level >= cut) {
        if (!speechRiseAtRef.current) speechRiseAtRef.current = now;
        if (now - speechRiseAtRef.current >= startHoldMs(cuts)) {
          speechRiseAtRef.current = 0;
          beginUtterance();
        }
      } else {
        speechRiseAtRef.current = 0;
      }
      if (speaking) {
        const voiced = level >= cut;
        if (voiced) lastVoiceRef.current = now;
        if (
          shouldEndUtterance({
            now,
            startAt: speechStartRef.current,
            lastVoiceAt: lastVoiceRef.current,
            voiced,
            silenceMs: session.silenceMs,
            maxUtteranceMs: session.sense.maxUtteranceMs,
          })
        ) {
          void flushUtterance();
        }
      }
    } else if (phaseRef.current === "speaking-you") {
      if (
        shouldEndUtterance({
          now,
          startAt: speechStartRef.current,
          lastVoiceAt: lastVoiceRef.current,
          voiced: false,
          silenceMs: getHearingSession().silenceMs,
          maxUtteranceMs: getHearingSession().sense.maxUtteranceMs,
        })
      ) {
        void flushUtterance();
      }
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [beginUtterance, flushUtterance]);

  const startSpeechRec = () => {
    if (pageIsHidden()) return;
    if (!usesBrowserStt()) return;
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    if (recRef.current) {
      if (recLiveRef.current) {
        logCallAudio("rec.start skipped (live)");
        return;
      }
      try {
        recRef.current.start();
        recLiveRef.current = true;
        logCallAudio("rec.start");
      } catch {
        logCallAudio("rec.start already");
      }
      return;
    }
    const rec = new Ctor();
    rec.lang = "zh-CN";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 3;
    rec.onresult = (ev) => {
      if (!liveRef.current || deafRef.current) return;
      if (performance.now() < listenReadyAtRef.current) return;
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
      const shown = live.trim()
        ? mergeSpeech(committed, live)
        : committed || live;
      interimRef.current = shown.trim();
      if ((addition || live).trim()) lastTextAtRef.current = performance.now();
    };
    rec.onstart = () => {
      recLiveRef.current = true;
    };
    rec.onend = () => {
      recLiveRef.current = false;
      logCallAudio("rec.onend");
      if (liveRef.current && !pageIsHidden()) {
        window.setTimeout(() => {
          if (!liveRef.current || pageIsHidden() || recLiveRef.current) return;
          try {
            rec.start();
            recLiveRef.current = true;
            logCallAudio("rec.start (onend)");
          } catch {
            logCallAudio("rec.start onend already");
          }
        }, isAppleTouch() ? 160 : 0);
      }
    };
    recRef.current = rec;
    try {
      rec.start();
      recLiveRef.current = true;
      logCallAudio("rec.start");
    } catch {
      logCallAudio("rec.start already");
    }
  };

  const start = useCallback(async () => {
    if (liveRef.current) return;
    setError(null);
    const nativeOwned = nativeCallPlan().callStart === "startNativeCall";
    nativeOwnedRef.current = nativeOwned;
    nativeStartCall(nativeCallParams());
    if (nativeOwned) {
      liveRef.current = true;
      setDeafBoth(false);
      setActive(true);
      setPhaseBoth("listening");
      nativeKeepAwake(true);
      return;
    }
    void unlockPlayback();
    try {
      const stream = await acquireMicFromGesture();
      streamRef.current = stream;
      const AudioCtx =
        window.AudioContext ||
        (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      const ctx = AudioCtx ? new AudioCtx() : null;
      if (ctx) watchAudioContext(ctx, "call");
      if (ctx?.state === "suspended") await ctx.resume();
      if (ctx) {
        ctxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = FFT_SIZE;
        analyser.smoothingTimeConstant = 0.35;
        source.connect(analyser);
        sourceRef.current = source;
        analyserRef.current = analyser;
        try {
          pcmTapRef.current = await attachPcmTap(ctx, source);
        } catch {
          pcmTapRef.current = null;
        }
      }
    } catch (err) {
      nativeEndCall();
      setError(micFailHint(err));
      hangup();
      return;
    }
    liveRef.current = true;
    setDeafBoth(false);
    noiseFloorRef.current = FLOOR_START;
    levelRef.current = 0;
    tickAtRef.current = 0;
    playbackIdleAtRef.current = 0;
    setNoiseFloor(FLOOR_START);
    hearAtRef.current = performance.now();
    listenReadyAtRef.current = hearAtRef.current + CALL_START_WARMUP_MS;
    setActive(true);
    setPhaseBoth("listening");
    nativeKeepAwake(true);
    setMicEnabled(streamRef.current, true);
    startSpeechRec();
    rafRef.current = requestAnimationFrame(tick);
    if (intervalRef.current) window.clearInterval(intervalRef.current);
    intervalRef.current = window.setInterval(() => {
      if (liveRef.current && !rafRef.current) rafRef.current = requestAnimationFrame(tick);
    }, 80);
    startCallHold();
    if (warmupTimerRef.current) window.clearTimeout(warmupTimerRef.current);
    warmupTimerRef.current = window.setTimeout(() => {
      warmupTimerRef.current = 0;
      if (!liveRef.current) return;
      pcmTapRef.current?.clear();
      logCallAudio("warmup-clear-ring");
    }, CALL_START_WARMUP_MS);
    try {
      wakeLockRef.current = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {
      /* ignore */
    }
  }, [hangup, tick]);

  const deafen = useCallback(() => {
    if (!liveRef.current || nativeOwnedRef.current) return;
    setDeafBoth(true);
    logCallAudio("deafen");
    speechRiseAtRef.current = 0;
    if (phaseRef.current === "transcribing") return;
    void pcmTapRef.current?.stop();
    if (phaseRef.current === "speaking-you") {
      try {
        if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      } catch {
        /* ignore */
      }
      recorderRef.current = null;
      chunksRef.current = [];
      framesRef.current = [];
      finalTextRef.current = "";
      interimRef.current = "";
      lastTextAtRef.current = 0;
    }
    setPhaseBoth("listening");
  }, []);

  const hear = useCallback(() => {
    if (!liveRef.current || nativeOwnedRef.current) return;
    setDeafBoth(false);
    setMicEnabled(streamRef.current, true);
    setPhaseBoth("listening");
    finalTextRef.current = "";
    interimRef.current = "";
    lastTextAtRef.current = 0;
    hearAtRef.current = performance.now();
    listenReadyAtRef.current = hearAtRef.current + POST_QINGRAN_MS;
    logCallAudio("hear");
    if (!pageIsHidden()) startSpeechRec();
  }, []);

  const revive = useCallback(async (opts?: { gesture?: boolean }) => {
    if (!liveRef.current) return;
    if (nativeOwnedRef.current) {
      if (!pageIsHidden()) nativeKeepAwake(true);
      return;
    }
    if (pageIsHidden() && !opts?.gesture) {
      nativeKeepAwake(false);
      keepPlaybackAlive();
      return;
    }
    nativeKeepAwake(true);
    try {
      if (ctxRef.current?.state === "closed") ctxRef.current = null;
      else if (ctxRef.current?.state === "suspended") await ctxRef.current.resume();
    } catch {
      /* ignore */
    }

    let stream = currentMic() || (micUsable(streamRef.current) ? streamRef.current : null);
    if (!micUsable(stream)) {
      if (!opts?.gesture) return;
      try {
        stream = await acquireMic();
      } catch {
        setError("麦克风被关掉了。点电话再开一次。");
        return;
      }
    }
    streamRef.current = stream;

    const AudioCtx =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!ctxRef.current && AudioCtx) {
      ctxRef.current = new AudioCtx();
      watchAudioContext(ctxRef.current, "call");
    }
    try {
      if (ctxRef.current?.state === "suspended") await ctxRef.current.resume();
    } catch {
      /* ignore */
    }
    if (ctxRef.current && stream) {
      try {
        pcmTapRef.current?.dispose();
      } catch {
        /* ignore */
      }
      pcmTapRef.current = null;
      try {
        sourceRef.current?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        const source = ctxRef.current.createMediaStreamSource(stream);
        const analyser = ctxRef.current.createAnalyser();
        analyser.fftSize = FFT_SIZE;
        analyser.smoothingTimeConstant = 0.35;
        source.connect(analyser);
        sourceRef.current = source;
        analyserRef.current = analyser;
        try {
          pcmTapRef.current = await attachPcmTap(ctxRef.current, source);
        } catch {
          pcmTapRef.current = null;
        }
      } catch {
        /* iOS can reject a second source until the next gesture */
      }
    }

    if (phaseRef.current === "speaking-you") {
      try {
        if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      } catch {
        /* ignore */
      }
      recorderRef.current = null;
      chunksRef.current = [];
      setPhaseBoth("listening");
    }

    const blocked =
      isPlaybackActive() ||
      recognizingRef.current ||
      Boolean(isGeneratingRef.current?.()) ||
      Boolean(isLabelingRef.current?.());
    if (!blocked && (deafRef.current || phaseRef.current !== "listening")) {
      hear();
    } else if (!deafRef.current) {
      setMicEnabled(streamRef.current, true);
      listenReadyAtRef.current = performance.now() + LISTEN_WARMUP_MS;
      startSpeechRec();
    }
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
    try {
      wakeLockRef.current = (await navigator.wakeLock?.request("screen")) ?? wakeLockRef.current;
    } catch {
      /* ignore */
    }
  }, [tick, hear]);

  useEffect(() => {
    if (!active) return;
    let since = 0;
    let reported = false;
    const id = window.setInterval(() => {
      if (!liveRef.current || nativeOwnedRef.current) return;
      const playing = isPlaybackActive();
      const generating = Boolean(isGeneratingRef.current?.());
      const recognizing = recognizingRef.current;
      const labeling = Boolean(isLabelingRef.current?.());
      const phaseNow = phaseRef.current;
      const deafNow = deafRef.current;
      const elapsed = since ? performance.now() - since : 0;
      const state = { phase: phaseNow, deaf: deafNow, playing, generating, recognizing, labeling };
      if (!callListenStuck({ ...state, stuckForMs: CALL_STUCK_MS })) {
        since = 0;
        reported = false;
        return;
      }
      if (!since) {
        since = performance.now();
        return;
      }
      if (!callListenStuck({ ...state, stuckForMs: elapsed }) || reported) return;
      reported = true;
      try {
        onStuckRef.current?.({ phase: phaseNow, deaf: deafNow });
      } catch {
        /* ignore */
      }
      hear();
    }, 500);
    return () => window.clearInterval(id);
  }, [active, hear]);

  useEffect(() => {
    if (!active) return;
    const restoreAfterReturn = () => {
      if (!liveRef.current) return;
      keepPlaybackAlive();
      if (pageIsHidden()) return;
      void revive();
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
  }, [active, revive]);

  useEffect(() => () => hangup(), [hangup]);

  useEffect(() => {
    const onNative = (event: Event) => {
      if (!liveRef.current) return;
      const detail = (event as CustomEvent<{ type?: string; phase?: CallPhase }>).detail;
      const phaseNow = detail?.phase;
      if (detail?.type === "phase" && (phaseNow === "listening" || phaseNow === "speaking-you" || phaseNow === "transcribing")) {
        setPhaseBoth(phaseNow);
      }
    };
    window.addEventListener("qingran-native-call", onNative);
    return () => window.removeEventListener("qingran-native-call", onNative);
  }, []);

  useEffect(() => {
    return listenNativeHangup(() => {
      if (!liveRef.current) return;
      nativeHangupRef.current = true;
      hangup();
      nativeHangupRef.current = false;
    });
  }, [hangup]);

  return {
    active,
    phase,
    level,
    threshold,
    listenSec,
    rms: rmsNow,
    hold: holdNow,
    deaf,
    noiseFloor,
    error,
    start,
    hangup,
    deafen,
    hear,
    revive,
  };
}
