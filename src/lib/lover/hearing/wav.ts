/** 16 kHz mono PCM16 WAV helpers used by connection tests and persist. */

import { prosodyFromSamples, type StoredProsody } from "../prosody.ts";

export function wavDurationMs(base64: string): number {
  try {
    const buf = Buffer.from(base64, "base64");
    if (buf.length < 44) return 0;
    const byteRate = buf.readUInt32LE(28) || 32_000;
    const dataSize = Math.max(0, buf.length - 44);
    return Math.round((dataSize / byteRate) * 1000);
  } catch {
    return 0;
  }
}

export function wavPeakRms(base64: string, sampleRate = 16_000): number {
  try {
    const buf = Buffer.from(base64, "base64");
    if (buf.length < 46) return 0;
    const frame = Math.max(1, Math.round(sampleRate * 0.02));
    let peak = 0;
    let i = 44;
    while (i + 1 < buf.length) {
      let sumSq = 0;
      let n = 0;
      for (let k = 0; k < frame && i + 1 < buf.length; k += 1, i += 2) {
        const sample = buf.readInt16LE(i) / 32768;
        sumSq += sample * sample;
        n += 1;
      }
      if (n) {
        const rms = Math.sqrt(sumSq / n);
        if (rms > peak) peak = rms;
      }
    }
    return peak;
  } catch {
    return 0;
  }
}

export function decodeWavPcm16(base64: string): { samples: Float32Array; sampleRate: number } | null {
  try {
    const buf = Buffer.from(base64, "base64");
    if (buf.length < 44) return null;
    if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
    let offset = 12;
    let sampleRate = 16_000;
    let channels = 1;
    let bits = 16;
    let dataStart = -1;
    let dataSize = 0;
    while (offset + 8 <= buf.length) {
      const id = buf.toString("ascii", offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      const next = offset + 8 + size;
      if (id === "fmt " && size >= 16) {
        channels = buf.readUInt16LE(offset + 10) || 1;
        sampleRate = buf.readUInt32LE(offset + 12) || 16_000;
        bits = buf.readUInt16LE(offset + 22) || 16;
      } else if (id === "data") {
        dataStart = offset + 8;
        dataSize = size;
        break;
      }
      offset = next + (size % 2);
    }
    if (dataStart < 0 || bits !== 16) return null;
    const frameBytes = 2 * Math.max(1, channels);
    const count = Math.max(0, Math.floor(Math.min(dataSize, buf.length - dataStart) / frameBytes));
    const samples = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      let sum = 0;
      for (let ch = 0; ch < channels; ch += 1) {
        sum += buf.readInt16LE(dataStart + i * frameBytes + ch * 2) / 32768;
      }
      samples[i] = sum / channels;
    }
    return { samples, sampleRate };
  } catch {
    return null;
  }
}

/** The browser call's usual loudness (median 20 ms peak of her clips there). */
const BROWSER_PEAK_RMS = 0.2;

/**
 * The iPhone shell can record her much quieter than the browser does. Pitch is only read on frames above a fixed
 * level, so a quiet clip of real words was judged noise and she had to shout. A quiet clip is raised to the browser's
 * usual level (at most 8×) before anything reads it; a clip already at that level is left as it is.
 */
export function liftQuietWav(base64: string, maxGain = 8): string {
  const peak = wavPeakRms(base64);
  if (!(peak > 0) || peak >= BROWSER_PEAK_RMS * 0.8) return base64;
  const decoded = decodeWavPcm16(base64);
  if (!decoded || !decoded.samples.length) return base64;
  const gain = Math.min(maxGain, BROWSER_PEAK_RMS / peak);
  const count = decoded.samples.length;
  const out = Buffer.alloc(44 + count * 2);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + count * 2, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(decoded.sampleRate, 24);
  out.writeUInt32LE(decoded.sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i += 1) {
    const v = Math.max(-1, Math.min(1, (decoded.samples[i] ?? 0) * gain));
    out.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), 44 + i * 2);
  }
  return out.toString("base64");
}

export function prosodyFromWav(base64: string, minClarity = 0.58): StoredProsody | null {
  const decoded = decodeWavPcm16(base64);
  if (!decoded || decoded.samples.length < 80) return null;
  return prosodyFromSamples(decoded.samples, decoded.sampleRate, undefined, minClarity);
}


