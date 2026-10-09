/**
 * His voice at one overall loudness, with the light and shade he asks for kept. xAI reads each reply (and each piece of
 * one) at its own level; every 20 ms of 16-bit PCM is measured and the gain follows how loud he has been over the last
 * few seconds, within ±4 dB of as read. A <whisper> or <soft> line, or a [laugh], is a change of a second or two, so it
 * stays quieter or louder than the lines around it; a whole reply read too quiet or too loud is brought toward one
 * level. Silence between words is not measured, and a soft limit keeps peaks from clipping.
 */
const FRAME = 480; // 20 ms at 24 kHz
const TARGET = 0.12; // RMS of voiced frames, ≈ −18 dBFS
const GATE = 0.012; // below this a frame is the gap between words
const GAIN_MIN = 0.6;
const GAIN_MAX = 1.6;
/** How far back "how loud he has been" looks: long against a tagged line, short against a whole reply. */
const LEVEL_MS = 3000;
const A = 1 - Math.exp(-20 / LEVEL_MS);
/** The first second and a half of a reply is averaged as it comes, so a short reply is levelled from its start. */
const OPENING_FRAMES = 75;
const KNEE = 0.85;

export class VoiceLeveler {
  private level = TARGET;
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
        this.voiced += 1;
        this.level += (rms - this.level) * (this.voiced <= OPENING_FRAMES ? 1 / this.voiced : A);
        this.gain = Math.min(GAIN_MAX, Math.max(GAIN_MIN, TARGET / this.level));
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
