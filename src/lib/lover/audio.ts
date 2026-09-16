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

export function qingranNativePresent() {
  if (typeof window === "undefined") return false;
  const native = (window as Window & { QingranNative?: { present?: boolean } }).QingranNative;
  return Boolean(native?.present);
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
  return Boolean(stream?.getAudioTracks().some((track) => track.readyState === "live"));
}

export function currentMic(): MediaStream | null {
  return micUsable(sharedMic) ? sharedMic : null;
}

export async function acquireMic(): Promise<MediaStream> {
  if (micUsable(sharedMic) && sharedMic) {
    setMicEnabled(sharedMic, true);
    return sharedMic;
  }
  sharedMic = await navigator.mediaDevices.getUserMedia({ audio: micAudioConstraints() });
  for (const track of sharedMic.getAudioTracks()) {
    track.addEventListener("mute", () => {
      /* iOS mutes on background; unmute restores it */
    });
    track.addEventListener("unmute", () => {
      if (sharedMic) setMicEnabled(sharedMic, true);
    });
  }
  return sharedMic;
}

export function pauseMic() {
  setMicEnabled(sharedMic, false);
}

export function releaseMic() {
  sharedMic?.getTracks().forEach((track) => track.stop());
  sharedMic = null;
}

export async function getMicStream(): Promise<MediaStream> {
  return acquireMic();
}

export function setMicEnabled(stream: MediaStream | null, enabled: boolean) {
  stream?.getAudioTracks().forEach((track) => {
    track.enabled = enabled;
  });
}

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
