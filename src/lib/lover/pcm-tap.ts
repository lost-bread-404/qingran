const STT_RATE = 16_000;
export const PRE_ROLL_SEC = 0.6;

const WORKLET = /* javascript */ `
class QingranPcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capturing = false;
    this.parts = [];
    this.filled = 0;
    this.ring = [];
    this.ringFilled = 0;
    this.preSamples = Math.max(1, Math.round(sampleRate * 0.6));
    this.port.onmessage = (event) => {
      if (event.data === "start") {
        this.capturing = true;
        this.parts = this.ring.map((part) => new Float32Array(part));
        this.filled = this.ringFilled;
      }
      if (event.data === "stop") {
        this.capturing = false;
        this.flush();
        this.port.postMessage({ type: "end" });
      }
      if (event.data === "clear") {
        this.ring = [];
        this.ringFilled = 0;
      }
    };
  }
  pushRing(chunk) {
    this.ring.push(chunk);
    this.ringFilled += chunk.length;
    while (this.ringFilled > this.preSamples && this.ring.length > 1) {
      const first = this.ring.shift();
      this.ringFilled -= first.length;
    }
    if (this.ringFilled > this.preSamples && this.ring.length === 1) {
      const extra = this.ringFilled - this.preSamples;
      this.ring[0] = this.ring[0].subarray(extra);
      this.ringFilled = this.preSamples;
    }
  }
  flush() {
    if (!this.parts.length) return;
    let total = 0;
    for (const part of this.parts) total += part.length;
    const out = new Float32Array(total);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.length;
    }
    this.parts = [];
    this.filled = 0;
    this.port.postMessage({ type: "chunk", samples: out }, [out.buffer]);
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || !ch.length) return true;
    const copy = new Float32Array(ch);
    this.pushRing(copy);
    if (!this.capturing) return true;
    this.parts.push(new Float32Array(ch));
    this.filled += ch.length;
    if (this.filled >= 4096) this.flush();
    return true;
  }
}
registerProcessor("qingran-pcm-tap", QingranPcmTap);
`;

export type PcmTap = {
  start: () => void;
  stop: () => Promise<Float32Array>;
  clear: () => void;
  dispose: () => void;
};

export type SampleRing = {
  chunks: Float32Array[];
  filled: number;
};

export function createSampleRing(): SampleRing {
  return { chunks: [], filled: 0 };
}

export function pushSampleRing(ring: SampleRing, chunk: Float32Array, capacity: number) {
  if (!chunk.length || capacity <= 0) return;
  ring.chunks.push(chunk);
  ring.filled += chunk.length;
  while (ring.filled > capacity && ring.chunks.length > 1) {
    const first = ring.chunks.shift();
    if (!first) break;
    ring.filled -= first.length;
  }
  if (ring.filled > capacity && ring.chunks.length === 1) {
    const extra = ring.filled - capacity;
    ring.chunks[0] = ring.chunks[0]!.subarray(extra);
    ring.filled = capacity;
  }
}

export function clearSampleRing(ring: SampleRing) {
  ring.chunks = [];
  ring.filled = 0;
}

export function snapshotSampleRing(ring: SampleRing): Float32Array {
  return concatFloats(ring.chunks);
}

export function downsample(input: Float32Array, fromRate: number, toRate: number) {
  if (fromRate === toRate) return input;
  if (fromRate <= 0 || toRate <= 0 || input.length === 0) return input;
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

export function encodeWavPcm16(samples: Float32Array, sampleRate: number, outRate = STT_RATE) {
  const mono = downsample(samples, sampleRate, outRate);
  const count = mono.length;
  const bytes = new ArrayBuffer(44 + count * 2);
  const view = new DataView(bytes);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + count * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, outRate, true);
  view.setUint32(28, outRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, count * 2, true);
  let offset = 44;
  for (let i = 0; i < count; i += 1) {
    const sample = Math.max(-1, Math.min(1, mono[i] ?? 0));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }
  return new Blob([bytes], { type: "audio/wav" });
}

export function wavFromTap(samples: Float32Array, sampleRate: number, minSec = 0.18) {
  if (samples.length / sampleRate < minSec) return null;
  return encodeWavPcm16(samples, sampleRate);
}

export function peakRms(samples: Float32Array, sampleRate = STT_RATE): number {
  if (!samples.length) return 0;
  const frame = Math.max(1, Math.round(sampleRate * 0.02));
  let peak = 0;
  for (let i = 0; i < samples.length; i += frame) {
    let sumSq = 0;
    const end = Math.min(samples.length, i + frame);
    for (let k = i; k < end; k += 1) sumSq += samples[k]! * samples[k]!;
    const rms = Math.sqrt(sumSq / (end - i));
    if (rms > peak) peak = rms;
  }
  return peak;
}

export async function attachPcmTap(
  ctx: AudioContext,
  source: MediaStreamAudioSourceNode,
): Promise<PcmTap> {
  try {
    return await attachWorklet(ctx, source);
  } catch {
    return attachProcessor(ctx, source);
  }
}

async function attachWorklet(ctx: AudioContext, source: MediaStreamAudioSourceNode): Promise<PcmTap> {
  const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const node = new AudioWorkletNode(ctx, "qingran-pcm-tap");
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);

  let chunks: Float32Array[] = [];
  let endWaiter: (() => void) | null = null;
  node.port.onmessage = (event) => {
    const data = event.data as { type?: string; samples?: Float32Array };
    if (data?.type === "chunk" && data.samples?.length) chunks.push(data.samples);
    if (data?.type === "end") endWaiter?.();
  };

  return {
    start() {
      chunks = [];
      node.port.postMessage("start");
    },
    stop() {
      return new Promise((resolve) => {
        const finish = () => resolve(concatFloats(chunks));
        const timer = window.setTimeout(() => {
          endWaiter = null;
          finish();
        }, 220);
        endWaiter = () => {
          window.clearTimeout(timer);
          endWaiter = null;
          finish();
        };
        node.port.postMessage("stop");
      });
    },
    clear() {
      node.port.postMessage("clear");
    },
    dispose() {
      try {
        node.port.postMessage("stop");
      } catch {
        /* ignore */
      }
      try {
        source.disconnect(node);
      } catch {
        /* ignore */
      }
      try {
        node.disconnect();
        mute.disconnect();
      } catch {
        /* ignore */
      }
    },
  };
}

function attachProcessor(ctx: AudioContext, source: MediaStreamAudioSourceNode): PcmTap {
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  let capturing = false;
  let chunks: Float32Array[] = [];
  const ring = createSampleRing();
  const capacity = Math.max(1, Math.round(ctx.sampleRate * PRE_ROLL_SEC));
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const copy = new Float32Array(input);
    pushSampleRing(ring, copy, capacity);
    if (!capturing) return;
    chunks.push(new Float32Array(input));
  };
  source.connect(processor);
  processor.connect(mute);
  mute.connect(ctx.destination);
  return {
    start() {
      chunks = [snapshotSampleRing(ring)];
      capturing = true;
    },
    stop() {
      capturing = false;
      return Promise.resolve(concatFloats(chunks));
    },
    clear() {
      clearSampleRing(ring);
    },
    dispose() {
      capturing = false;
      processor.onaudioprocess = null;
      try {
        source.disconnect(processor);
      } catch {
        /* ignore */
      }
      try {
        processor.disconnect();
        mute.disconnect();
      } catch {
        /* ignore */
      }
    },
  };
}

function concatFloats(parts: Float32Array[]) {
  if (parts.length === 0) return new Float32Array(0);
  if (parts.length === 1) return parts[0] ?? new Float32Array(0);
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}
