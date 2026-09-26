import {
  getAudioSession,
  micStreamUsable,
  claimListenSession,
  yieldAudioSession,
  resumeAudioContext,
  watchAudioContext,
  closeAudioContext,
} from "@/lib/lover/audio-session";
import { logCallAudio } from "@/lib/lover/call-audio-log";

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
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
    sampleRate: { ideal: 48000 },
  };
}

let sharedMic: MediaStream | null = null;
let micGen = 0;
const micListeners = new Set<(event: "mute" | "unmute" | "ended") => void>();

function emitMicEvent(event: "mute" | "unmute" | "ended") {
  logCallAudio(`track ${event}`);
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
  logCallAudio("rec.stop");
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
}

export function micFailHint(err: unknown) {
  const name = (err as { name?: string } | null)?.name ?? "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return "点电话重新接通";
  }
  if (name === "AbortError") return "点电话重新接通";
  return "点电话重新接通";
}

let acquireChain: Promise<unknown> = Promise.resolve();

function beginMicRequest(): Promise<MediaStream> {
  const gen = ++micGen;
  logCallAudio("acquireMic");
  if (sharedMic) {
    dropMic(sharedMic);
    sharedMic = null;
  }
  claimListenSession();
  return requestMic().then((stream) => {
    if (gen !== micGen) {
      dropMic(stream);
      throw new DOMException("superseded", "AbortError");
    }
    sharedMic = stream;
    bindTrackWatchers(stream);
    setMicEnabled(stream, true);
    claimListenSession();
    return stream;
  });
}

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

async function acquireMicInner(_opts?: { force?: boolean }): Promise<MediaStream> {
  if (sharedMic && micUsable(sharedMic)) {
    setMicEnabled(sharedMic, true);
    return sharedMic;
  }
  return beginMicRequest();
}

export function acquireMicFromGesture(): Promise<MediaStream> {
  const pending = beginMicRequest();
  acquireChain = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
}

export function pauseMic() {
  logCallAudio("pauseMic");
  setMicEnabled(sharedMic, false);
}

export function releaseMic() {
  const had = Boolean(sharedMic);
  const sessionType = getAudioSession()?.type;
  logCallAudio(`releaseMic had=${had ? "1" : "0"} session=${sessionType || "∅"}`);
  micGen += 1;
  dropMic(sharedMic);
  sharedMic = null;
  if (had || sessionType === "play-and-record") yieldAudioSession();
}

export function setMicEnabled(stream: MediaStream | null, enabled: boolean) {
  stream?.getAudioTracks().forEach((track) => {
    track.enabled = enabled;
  });
}

export { getAudioSession, claimListenSession, yieldAudioSession, resumeAudioContext, watchAudioContext, closeAudioContext };

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
  onstart: (() => void) | null;
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
