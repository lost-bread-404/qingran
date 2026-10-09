/**
 * Her microphone as what xAI's recognizer takes: 16 kHz, 16-bit, mono, in frames of 100 ms, with how loud each frame
 * was. The browser's echo cancelling and gain control are on (he may still be in the room); nothing here decides when
 * she speaks. Used outside the iPhone shell (the shell has its own microphone, ios/Qingran/Qingran/Voice.swift).
 */

export type MicFrame = { pcm: Int16Array<ArrayBuffer>; rms: number };

const WORKLET = /* javascript */ `
class QingranMic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 16000;
    this.pos = 0;
    this.acc = 0;
    this.count = 0;
    this.out = new Int16Array(1600);
    this.filled = 0;
    this.sumSq = 0;
    this.port.onmessage = (event) => {
      if (event.data === "flush") {
        this.send();
        this.port.postMessage({ flushed: true });
      }
    };
  }
  send() {
    if (!this.filled) return;
    const pcm = this.out.slice(0, this.filled);
    const rms = Math.sqrt(this.sumSq / this.filled);
    this.port.postMessage({ pcm, rms }, [pcm.buffer]);
    this.filled = 0;
    this.sumSq = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i += 1) {
      // Each 16 kHz sample is the mean of the input samples it covers (a simple low-pass before thinning).
      this.acc += ch[i];
      this.count += 1;
      this.pos += 1;
      if (this.pos < this.step) continue;
      this.pos -= this.step;
      const x = Math.max(-1, Math.min(1, this.acc / this.count));
      this.acc = 0;
      this.count = 0;
      this.out[this.filled] = x < 0 ? x * 32768 : x * 32767;
      this.sumSq += x * x;
      this.filled += 1;
      if (this.filled === this.out.length) this.send();
    }
    return true;
  }
}
registerProcessor("qingran-mic", QingranMic);
`;

function audioCtor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  return window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

export class Mic {
  /** Every frame while the mic is on. */
  onFrame: ((frame: MicFrame) => void) | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private starting: Promise<void> | null = null;
  private flushWaiter: (() => void) | null = null;
  private gen = 0;

  get on(): boolean {
    return Boolean(this.node);
  }

  /** On, and the browser has not taken the mic away (iOS ends it when the page goes to the background). */
  get alive(): boolean {
    return Boolean(this.node) && Boolean(this.stream?.getAudioTracks().some((t) => t.readyState === "live"));
  }

  /** Call from her tap: the audio context is made inside the gesture, then the microphone is asked for. */
  start(): Promise<void> {
    if (this.node) return Promise.resolve();
    if (this.starting) return this.starting;
    const gen = ++this.gen;
    const Ctor = audioCtor();
    if (!Ctor || !navigator.mediaDevices?.getUserMedia) return Promise.reject(new Error("这个浏览器不能录音。"));
    const ctx = this.ctx && this.ctx.state !== "closed" ? this.ctx : new Ctor();
    this.ctx = ctx;
    void ctx.resume().catch(() => undefined);
    const run = (async () => {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true, channelCount: 1 },
      });
      if (gen !== this.gen) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      if (gen !== this.gen) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      await ctx.resume().catch(() => undefined);
      if (gen !== this.gen) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "qingran-mic");
      node.port.onmessage = (event: MessageEvent<{ pcm?: Int16Array<ArrayBuffer>; rms?: number; flushed?: boolean }>) => {
        const data = event.data;
        if (data.flushed) {
          this.flushWaiter?.();
          this.flushWaiter = null;
          return;
        }
        if (data.pcm) this.onFrame?.({ pcm: data.pcm, rms: data.rms ?? 0 });
      };
      source.connect(node);
      // Pulled by the graph; it writes nothing, so nothing is heard.
      node.connect(ctx.destination);
      this.stream = stream;
      this.source = source;
      this.node = node;
    })();
    const starting = run.finally(() => {
      if (this.starting === starting) this.starting = null;
    });
    this.starting = starting;
    return starting;
  }

  /** The part of a frame not yet sent (at most 100 ms) goes out now; resolves when it has. */
  flush(): Promise<void> {
    if (!this.node) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.flushWaiter = null;
        resolve();
      }, 150);
      this.flushWaiter = () => {
        window.clearTimeout(timer);
        resolve();
      };
      this.node?.port.postMessage("flush");
    });
  }

  /** Lets go of the microphone (the page stops showing it in use). The audio context is kept for the next time. */
  stop() {
    this.gen += 1;
    // A start still waiting for the browser gives up (it sees the new gen); the next start begins afresh.
    this.starting = null;
    this.flushWaiter?.();
    this.flushWaiter = null;
    try {
      this.source?.disconnect();
      this.node?.disconnect();
    } catch {
      /* already gone */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.source = null;
    this.node = null;
  }
}

/** One microphone for the page (holding to talk and calls never run at once). */
export const mic = new Mic();

/** A whole held line as a 16 kHz WAV, for when the stream could not be opened. */
export function wavFromFrames(frames: Int16Array[]): Blob {
  let count = 0;
  for (const f of frames) count += f.length;
  const buf = new ArrayBuffer(44 + count * 2);
  const view = new DataView(buf);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + count * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, count * 2, true);
  let at = 44;
  for (const f of frames) {
    for (let i = 0; i < f.length; i += 1) {
      view.setInt16(at, f[i]!, true);
      at += 2;
    }
  }
  return new Blob([buf], { type: "audio/wav" });
}
