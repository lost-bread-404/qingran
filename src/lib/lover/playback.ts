import { resumeAudioContext, setAudioSessionKind } from "@/lib/lover/audio-session";

const SILENCE =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

const PCM_RATE = 24_000;
const START_SEC = 0.7;
// At iOS max volume this should feel like a normal half-volume phone.
export const VOICE_GAIN = 0.5;

let ctx: AudioContext | null = null;
let masterIn: AudioNode | null = null;
let masterGain: GainNode | null = null;
let masterCtx: AudioContext | null = null;
let unlocked = false;
let playGen = 0;
let nextStart = 0;
let startedClock = false;
let ended = false;
let inFlight = 0;
let pendingSamples = 0;
const liveSources = new Set<AudioBufferSourceNode>();
const sampleQueue: Float32Array[] = [];
let idleWaiters: Array<() => void> = [];

function audioCtor() {
  return (
    window.AudioContext ||
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  );
}

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = audioCtor();
  if (!Ctor) return null;
  if (ctx && (ctx.state as string) === "closed") ctx = null;
  if (!ctx) ctx = new Ctor();
  return ctx;
}

function applyVoiceGain(node: GainNode, audioCtx: AudioContext) {
  try {
    node.gain.cancelScheduledValues(audioCtx.currentTime);
    node.gain.setValueAtTime(VOICE_GAIN, audioCtx.currentTime);
  } catch {
    node.gain.value = VOICE_GAIN;
  }
}

function getOutput(audioCtx: AudioContext): AudioNode {
  if (masterIn && masterGain && masterCtx === audioCtx) {
    applyVoiceGain(masterGain, audioCtx);
    return masterIn;
  }
  const gain = audioCtx.createGain();
  applyVoiceGain(gain, audioCtx);
  gain.connect(audioCtx.destination);
  masterIn = gain;
  masterGain = gain;
  masterCtx = audioCtx;
  return gain;
}

function replaceCtx() {
  if (ctx) {
    try {
      void ctx.close();
    } catch {
      /* ignore */
    }
  }
  ctx = null;
  masterIn = null;
  masterGain = null;
  masterCtx = null;
  const Ctor = typeof window === "undefined" ? null : audioCtor();
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

export function getPlaybackElement(): HTMLAudioElement {
  const existing = document.getElementById("qingran-voice") as HTMLAudioElement | null;
  if (existing) return existing;
  const el = document.createElement("audio");
  el.id = "qingran-voice";
  el.setAttribute("playsinline", "true");
  el.setAttribute("webkit-playsinline", "true");
  el.preload = "auto";
  el.style.display = "none";
  document.body.appendChild(el);
  return el;
}

function clearElement(el: HTMLAudioElement) {
  try {
    el.pause();
    el.muted = true;
    el.removeAttribute("src");
    el.src = "";
    el.load();
  } catch {
    /* ignore */
  }
}

function looksLikeMpeg(bytes: Uint8Array) {
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true;
  return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0;
}

function looksLikeWav(bytes: Uint8Array) {
  return bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
}

function isRawPcm(bytes: Uint8Array, mimeType: string) {
  if (looksLikeWav(bytes) || looksLikeMpeg(bytes)) return false;
  const mime = mimeType.toLowerCase();
  return /pcm/.test(mime) || /octet-stream/.test(mime) || mime.trim() === "";
}

function killSources() {
  for (const src of liveSources) {
    try {
      src.onended = null;
      src.stop();
    } catch {
      /* ignore */
    }
    try {
      src.disconnect();
    } catch {
      /* ignore */
    }
  }
  liveSources.clear();
}

function resetStream() {
  sampleQueue.length = 0;
  pendingSamples = 0;
  inFlight = 0;
  ended = false;
  nextStart = 0;
  startedClock = false;
  killSources();
}

function prepSpeak() {
  setAudioSessionKind("speak");
  try {
    const el = getPlaybackElement();
    el.volume = VOICE_GAIN;
    el.muted = false;
  } catch {
    /* ignore */
  }
}

export async function unlockPlayback() {
  const el = getPlaybackElement();
  const audioCtx = getCtx();
  try {
    if (audioCtx) await resumeAudioContext(audioCtx);
  } catch {
    /* ignore */
  }
  try {
    el.muted = true;
    el.volume = 0;
    el.src = SILENCE;
    const play = el.play();
    if (play) await play;
  } catch {
    /* ignore */
  } finally {
    clearElement(el);
    el.muted = false;
    el.volume = VOICE_GAIN;
    unlocked = true;
  }
}

export function stopPlayback() {
  playGen += 1;
  resetStream();
  wakeIdle();
  const el = getPlaybackElement();
  clearElement(el);
  el.muted = false;
  el.volume = VOICE_GAIN;
}

let holdUrl: string | null = null;
let holdPlaying = false;

function getHoldElement(): HTMLAudioElement {
  const existing = document.getElementById("qingran-hold") as HTMLAudioElement | null;
  if (existing) return existing;
  const el = document.createElement("audio");
  el.id = "qingran-hold";
  el.setAttribute("playsinline", "true");
  el.setAttribute("webkit-playsinline", "true");
  el.preload = "auto";
  el.loop = true;
  el.style.display = "none";
  document.body.appendChild(el);
  return el;
}

function quietLoopUrl() {
  if (holdUrl) return holdUrl;
  const rate = 8000;
  const seconds = 12;
  const n = rate * seconds;
  const dataSize = n * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const write = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < n; i += 1) {
    view.setInt16(44 + i * 2, i & 1 ? 1 : -1, true);
  }
  holdUrl = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  return holdUrl;
}

function claimMediaSession() {
  const session = navigator.mediaSession;
  if (!session) return;
  try {
    session.metadata = new MediaMetadata({
      title: "清然",
      artist: "通话中",
    });
    session.playbackState = "playing";
  } catch {
    /* older WebKit */
  }
}

function releaseMediaSession() {
  const session = navigator.mediaSession;
  if (!session) return;
  try {
    session.playbackState = "none";
    session.metadata = null;
  } catch {
    /* ignore */
  }
}

export function startCallHold() {
  holdPlaying = true;
  setAudioSessionKind("listen");
  claimMediaSession();
  const el = getHoldElement();
  try {
    el.loop = true;
    el.muted = false;
    el.volume = 0.01;
    if (!el.src) el.src = quietLoopUrl();
    const play = el.play();
    if (play) void play.catch(() => undefined);
  } catch {
    /* ignore */
  }
  const audioCtx = getCtx();
  if (audioCtx) void resumeAudioContext(audioCtx);
}

export function stopCallHold() {
  holdPlaying = false;
  releaseMediaSession();
  try {
    const el = getHoldElement();
    el.pause();
    el.muted = true;
  } catch {
    /* ignore */
  }
}

export function isCallHoldPlaying() {
  return holdPlaying;
}


export async function resumeAudio() {
  let audioCtx = getCtx();
  if (!audioCtx) return;
  let ok = false;
  try {
    ok = await resumeAudioContext(audioCtx);
  } catch {
    ok = false;
  }
  if (!ok) {
    killSources();
    audioCtx = replaceCtx();
    if (audioCtx) {
      try {
        ok = await resumeAudioContext(audioCtx);
      } catch {
        ok = audioCtx.state === "running";
      }
    }
  }
  try {
    const el = getPlaybackElement();
    el.muted = false;
    el.volume = VOICE_GAIN;
  } catch {
    /* ignore */
  }
  if (!audioCtx || audioCtx.state !== "running") return;
  try {
    const frames = Math.max(1, Math.floor(audioCtx.sampleRate * 0.04));
    const buffer = audioCtx.createBuffer(1, frames, audioCtx.sampleRate);
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(getOutput(audioCtx));
    src.start();
  } catch {
    /* ignore */
  }
}

export async function kickAudio() {
  await resumeAudio();
  const audioCtx = getCtx();
  if (audioCtx?.state === "running" && unlocked) return;
  await unlockPlayback();
}

export function enqueuePlayback(bytes: Uint8Array<ArrayBuffer>, mimeType: string) {
  prepSpeak();
  inFlight += 1;
  void ingest(bytes, mimeType, playGen).finally(() => {
    inFlight = Math.max(0, inFlight - 1);
    maybeWakeIdle();
  });
}

export function sealPlayback() {
  ended = true;
  flushScheduled(playGen);
  maybeWakeIdle();
}

async function ingest(bytes: Uint8Array<ArrayBuffer>, mimeType: string, gen: number) {
  if (gen !== playGen || bytes.byteLength < 2) return;
  if (isRawPcm(bytes, mimeType)) {
    pushSamples(pcmToFloats(bytes), gen);
    return;
  }
  const decoded = await decodeBytes(bytes);
  if (gen !== playGen) return;
  if (decoded) {
    pushSamples(copyChannel(decoded), gen, decoded.sampleRate);
    return;
  }
  pushSamples(pcmToFloats(bytes), gen);
}

function pcmToFloats(bytes: Uint8Array<ArrayBuffer>) {
  const count = Math.floor(bytes.byteLength / 2);
  const floats = new Float32Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
  for (let i = 0; i < count; i += 1) {
    floats[i] = view.getInt16(i * 2, true) / 32768;
  }
  return floats;
}

function copyChannel(buffer: AudioBuffer) {
  const data = buffer.getChannelData(0);
  const copy = new Float32Array(data.length);
  copy.set(data);
  return copy;
}

function pushSamples(samples: Float32Array, gen: number, sampleRate = PCM_RATE) {
  if (gen !== playGen || samples.length === 0) return;
  const ready = sampleRate === PCM_RATE ? samples : resample(samples, sampleRate, PCM_RATE);
  sampleQueue.push(ready);
  pendingSamples += ready.length;
  flushScheduled(gen);
}

function resample(input: Float32Array, fromRate: number, toRate: number) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.max(1, Math.round(input.length / ratio)));
  for (let i = 0; i < out.length; i += 1) {
    const pos = i * ratio;
    const index = Math.floor(pos);
    const frac = pos - index;
    const a = input[index] ?? 0;
    const b = input[index + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

function flushScheduled(gen: number) {
  const audioCtx = getCtx();
  if (!audioCtx || gen !== playGen) return;
  try {
    if (audioContextNeedsResumeLocal(audioCtx.state)) void audioCtx.resume();
  } catch {
    /* ignore */
  }
  if (!startedClock) {
    if (!ended && pendingSamples / PCM_RATE < START_SEC) return;
    nextStart = Math.max(audioCtx.currentTime + 0.03, nextStart);
    startedClock = true;
  }
  while (sampleQueue.length) {
    const chunk = sampleQueue.shift();
    if (!chunk || chunk.length === 0) continue;
    pendingSamples -= chunk.length;
    const buffer = audioCtx.createBuffer(1, chunk.length, PCM_RATE);
    buffer.getChannelData(0).set(chunk);
    scheduleBuffer(buffer, audioCtx, gen);
  }
}

function audioContextNeedsResumeLocal(state: AudioContextState) {
  const value = state as string;
  return value === "suspended" || value === "interrupted";
}

function scheduleBuffer(buffer: AudioBuffer, audioCtx: AudioContext, gen: number) {
  if (gen !== playGen) return;
  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(getOutput(audioCtx));
  const now = audioCtx.currentTime;
  if (nextStart < now + 0.005) nextStart = now + 0.005;
  src.start(nextStart);
  nextStart += buffer.duration;
  liveSources.add(src);
  src.onended = () => {
    liveSources.delete(src);
    maybeWakeIdle();
  };
}

async function decodeBytes(bytes: Uint8Array<ArrayBuffer>): Promise<AudioBuffer | null> {
  const audioCtx = getCtx();
  if (!audioCtx) return null;
  try {
    await resumeAudioContext(audioCtx);
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return await audioCtx.decodeAudioData(copy);
  } catch {
    return null;
  }
}

function maybeWakeIdle() {
  if (ended && inFlight === 0 && sampleQueue.length === 0 && liveSources.size === 0) wakeIdle();
}

function wakeIdle() {
  const waiters = idleWaiters.splice(0);
  for (const waiter of waiters) waiter();
}

export function whenPlaybackIdle(): Promise<void> {
  if (ended && inFlight === 0 && sampleQueue.length === 0 && liveSources.size === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => idleWaiters.push(resolve));
}

export async function playMp3Bytes(
  bytes: Uint8Array<ArrayBuffer>,
  mimeType: string,
): Promise<boolean> {
  prepSpeak();
  const gen = playGen;
  inFlight += 1;
  try {
    await ingest(bytes, mimeType, gen);
  } finally {
    inFlight = Math.max(0, inFlight - 1);
  }
  sealPlayback();
  if (gen === playGen) await whenPlaybackIdle();
  return gen === playGen;
}

export function isPlaybackUnlocked() {
  return unlocked;
}

export function currentPlayGen() {
  return playGen;
}
