/** 16 kHz mono PCM16 WAV helpers used by connection tests and persist. */

export function silenceWavBase64(seconds = 1, sampleRate = 16_000): string {
  const count = Math.max(1, Math.round(seconds * sampleRate));
  const dataBytes = count * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  return buf.toString("base64");
}

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
