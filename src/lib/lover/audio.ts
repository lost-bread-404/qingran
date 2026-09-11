import {
  getAudioSession,
  micStreamUsable,
  claimListenSession,
  yieldAudioSession,
  resumeAudioContext,
} from "@/lib/lover/audio-session";

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read-failed"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function concatBytes(chunks: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  if (chunks.length === 1) return chunks[0] ?? new Uint8Array();
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function base64ToAudioUrl(base64: string, mimeType: string): string {
  const bytes = base64ToBytes(base64);
  const blob = new Blob([bytes], { type: mimeType });
  return URL.createObjectURL(blob);
}

export function pickRecorderMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? "";
}

export function startRecorder(recorder: MediaRecorder, timeslice = 250) {
  try {
    recorder.start(timeslice);
  } catch {
    recorder.start();
  }
}

export function micAudioConstraints(): MediaTrackConstraints {
  return {
    echoCancellation: true,
    // Keep breaths, sobs, and quiet cues — noise suppression wipes them.
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  };
}

let sharedMic: MediaStream | null = null;
const micListeners = new Set<(event: "mute" | "unmute" | "ended") => void>();

export function onMicEvent(listener: (event: "mute" | "unmute" | "ended") => void) {
  micListeners.add(listener);
  return () => {
    micListeners.delete(listener);
  };
}

function emitMicEvent(event: "mute" | "unmute" | "ended") {
  for (const listener of micListeners) listener(event);
}

export function isAppleTouch() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

export function usesBrowserStt(): boolean {
  return Boolean(getSpeechRecognitionCtor());
}

export function stopRecognition(rec: SpeechRecognitionLike | null): Promise<void> {
  if (!rec) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(done, 480);
    rec.onend = done;
    try {
      rec.stop();
    } catch {
      done();
    }
  });
}

export function micUsable(stream: MediaStream | null) {
  return micStreamUsable(stream);
}

export function currentMic(): MediaStream | null {
  return micUsable(sharedMic) ? sharedMic : null;
}

function getMicKeepAlive(): HTMLAudioElement | null {
  if (typeof document === "undefined") return null;
  const existing = document.getElementById("qingran-mic") as HTMLAudioElement | null;
  if (existing) return existing;
  const el = document.createElement("audio");
  el.id = "qingran-mic";
  el.setAttribute("playsinline", "true");
  el.setAttribute("webkit-playsinline", "true");
  el.muted = true;
  el.autoplay = true;
  el.style.display = "none";
  document.body.appendChild(el);
  return el;
}

function keepMicHot(stream: MediaStream) {
  const el = getMicKeepAlive();
  if (!el) return;
  try {
    if (el.srcObject !== stream) el.srcObject = stream;
    void el.play();
  } catch {
    /* ignore */
  }
}

function bindTrackWatchers(stream: MediaStream) {
  for (const track of stream.getAudioTracks()) {
    track.addEventListener("mute", () => emitMicEvent("mute"));
    track.addEventListener("unmute", () => {
      if (sharedMic) setMicEnabled(sharedMic, true);
      emitMicEvent("unmute");
    });
    track.addEventListener("ended", () => emitMicEvent("ended"));
  }
}

async function requestMic(): Promise<MediaStream> {
  const tryGet = (audio: boolean | MediaTrackConstraints) =>
    navigator.mediaDevices.getUserMedia({ audio });
  try {
    return await tryGet(micAudioConstraints());
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (
      name === "OverconstrainedError" ||
      name === "ConstraintNotSatisfiedError" ||
      name === "NotReadableError"
    ) {
      return await tryGet(true);
    }
    throw err;
  }
}

function dropMic(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch {
      /* ignore */
    }
  });
  const el =
    typeof document === "undefined"
      ? null
      : (document.getElementById("qingran-mic") as HTMLAudioElement | null);
  if (el) {
    try {
      el.srcObject = null;
      el.load();
    } catch {
      /* ignore */
    }
  }
}

export function micFailHint(err: unknown) {
  const name = (err as { name?: string } | null)?.name ?? "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return "系统设置里打开麦克风，再点这里";
  }
  return "点一下，打开麦克风";
}

let acquireChain: Promise<unknown> = Promise.resolve();

export async function acquireMic(opts?: { force?: boolean }): Promise<MediaStream> {
  const run = acquireChain.then(
    () => acquireMicInner(opts),
    () => acquireMicInner(opts),
  );
  acquireChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function acquireMicInner(opts?: { force?: boolean }): Promise<MediaStream> {
  claimListenSession();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });

  if (!opts?.force && sharedMic) {
    if (micUsable(sharedMic)) {
      setMicEnabled(sharedMic, true);
      keepMicHot(sharedMic);
      claimListenSession();
      return sharedMic;
    }
    const stillLive =
      sharedMic.active && sharedMic.getAudioTracks().some((track) => track.readyState === "live");
    if (stillLive) {
      setMicEnabled(sharedMic, true);
      keepMicHot(sharedMic);
      await new Promise((resolve) => window.setTimeout(resolve, 60));
      if (micUsable(sharedMic)) {
        claimListenSession();
        return sharedMic;
      }
    }
  }

  if (sharedMic) {
    dropMic(sharedMic);
    sharedMic = null;
  }

  sharedMic = await requestMic();
  bindTrackWatchers(sharedMic);
  setMicEnabled(sharedMic, true);
  keepMicHot(sharedMic);
  claimListenSession();
  return sharedMic;
}

export function pauseMic() {
  setMicEnabled(sharedMic, false);
}

export function releaseMic() {
  dropMic(sharedMic);
  sharedMic = null;
  yieldAudioSession();
}

export async function getMicStream(): Promise<MediaStream> {
  return acquireMic();
}

export function setMicEnabled(stream: MediaStream | null, enabled: boolean) {
  stream?.getAudioTracks().forEach((track) => {
    track.enabled = enabled;
  });
}

export async function resumeOrReplaceContext(ctx: AudioContext | null): Promise<AudioContext | null> {
  if (ctx && (ctx.state as string) !== "closed") {
    const ok = await resumeAudioContext(ctx);
    if (ok) return ctx;
    try {
      await ctx.close();
    } catch {
      /* ignore */
    }
  }
  const Ctor =
    window.AudioContext ||
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  const next = new Ctor();
  try {
    await next.resume();
  } catch {
    /* ignore */
  }
  return next;
}

export { getAudioSession, claimListenSession, yieldAudioSession, resumeAudioContext };

export function tapHaptic(kind: "start" | "end") {
  try {
    navigator.vibrate?.(kind === "start" ? 14 : 24);
  } catch {
    /* ignore */
  }
}

type SpeechCtor = new () => SpeechRecognitionLike;

export type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((ev: SpeechResultEvent) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
};

type SpeechResultEvent = {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    length: number;
    [index: number]: { transcript: string };
  }>;
};

export function getSpeechRecognitionCtor(): SpeechCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & {
    SpeechRecognition?: SpeechCtor;
    webkitSpeechRecognition?: SpeechCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function rmsFromTimeDomain(data: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) {
    const v = (data[i]! - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / data.length);
}
