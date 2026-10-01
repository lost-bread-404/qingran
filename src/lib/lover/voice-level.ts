/**
 * His voice at one loudness. xAI speaks each piece of a reply (and each reply) with its own level, so a quiet line can
 * follow a loud one. Every 20 ms of 16-bit PCM is measured; the gain follows how loud his voice has been (quickly at the
 * start of a reply; after that faster when he gets louder than when he gets softer) toward one target, moves smoothly from frame to frame, and a soft limit keeps peaks
 * from clipping. Silence between words is not measured, so it is not pulled up.
 */
const FRAME = 480; // 20 ms at 24 kHz
const TARGET = 0.12; // RMS of voiced frames, ≈ −18 dBFS
const GATE = 0.012; // below this a frame is the gap between words
const GAIN_MIN = 0.5;
const GAIN_MAX = 3;
const KNEE = 0.85;

export class VoiceLeveler {
  private level = 0;
  private voiced = 0;
  private gain = 1;
  private carry: Buffer | null = null;

  /** Levels a base64 piece of PCM16 little-endian mono and returns it as base64. */
  base64(b64: string): string {
    return this.pcm(Buffer.from(b64, "base64")).toString("base64");
  }

  pcm(input: Buffer): Buffer {
    let buf = this.carry ? Buffer.concat([this.carry, input]) : input;
    this.carry = null;
    if (buf.length % 2) {
      this.carry = buf.subarray(buf.length - 1);
      buf = buf.subarray(0, buf.length - 1);
    }
    const n = buf.length / 2;
    const out = Buffer.alloc(buf.length);
    for (let start = 0; start < n; start += FRAME) {
      const end = Math.min(n, start + FRAME);
      let sum = 0;
      for (let i = start; i < end; i++) {
        const x = buf.readInt16LE(i * 2) / 32768;
        sum += x * x;
      }
      const rms = Math.sqrt(sum / Math.max(1, end - start));
      const from = this.gain;
      if (rms >= GATE) {
        // A louder line is caught within about 0.2 s; a softer one is lifted over about half a second.
        const a = this.voiced < 10 ? 0.35 : rms > this.level ? 0.12 : 0.04;
        this.level = this.level ? this.level + (rms - this.level) * a : rms;
        this.voiced += 1;
        const want = Math.min(GAIN_MAX, Math.max(GAIN_MIN, TARGET / this.level));
        this.gain += (want - this.gain) * (this.voiced <= 10 ? 0.5 : 0.15);
      }
      const span = Math.max(1, end - start);
      for (let i = start; i < end; i++) {
        const g = from + ((this.gain - from) * (i - start + 1)) / span;
        out.writeInt16LE(Math.round(limit((buf.readInt16LE(i * 2) / 32768) * g) * 32767), i * 2);
      }
    }
    return out;
  }
}

function limit(y: number): number {
  const m = Math.abs(y);
  if (m <= KNEE) return y;
  return Math.sign(y) * (KNEE + (1 - KNEE) * Math.tanh((m - KNEE) / (1 - KNEE)));
}

/** A whole clip from the non-streaming endpoint, leveled the same way when it is raw PCM (as the players read it). */
export function levelClip(buf: Buffer, mime: string): Buffer {
  const head = buf.subarray(0, 4).toString("latin1");
  const packed = head === "RIFF" || head.startsWith("ID3") || (buf[0] === 0xff && ((buf[1] ?? 0) & 0xe0) === 0xe0);
  return !packed && (/pcm|octet-stream/i.test(mime) || !mime.trim()) ? new VoiceLeveler().pcm(buf) : buf;
}
