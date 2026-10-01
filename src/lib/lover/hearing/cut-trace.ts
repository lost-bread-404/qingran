import { holdBar, nextFloor, smoothLevel, type VadCuts } from "../vad.ts";
import { decodeWavPcm16 } from "./wav.ts";

/**
 * Why the phone decided she had finished, read back from the clip it sent: the same level and floor rules
 * (src/lib/lover/vad.ts) replayed over her audio from the floor it had when she started. Written on the stt log line,
 * so a line cut in the middle shows whether she went quiet or her voice fell under a hold line that had climbed.
 */
export function cutTrace(base64: string, cuts: VadCuts, startFloor: number | undefined, endWaitMs: number): string {
  const wav = decodeWavPcm16(base64);
  if (!wav || !wav.samples.length) return "";
  const step = Math.max(1, Math.round(wav.sampleRate * 0.02));
  const dt = (step / wav.sampleRate) * 1000;
  let level = 0;
  let floor = startFloor && startFloor > 0 ? startFloor : 0;
  const voiced: number[] = [];
  const tail: number[] = [];
  const total = wav.samples.length / wav.sampleRate * 1000;
  for (let at = 0; at + step <= wav.samples.length; at += step) {
    let sum = 0;
    for (let i = at; i < at + step; i += 1) sum += wav.samples[i]! * wav.samples[i]!;
    level = smoothLevel(level, Math.sqrt(sum / step), dt);
    floor = nextFloor(floor, level, dt, true);
    const t = (at / wav.sampleRate) * 1000;
    if (level >= holdBar(floor, cuts)) voiced.push(level);
    if (t >= total - endWaitMs) tail.push(level);
  }
  const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : 0);
  const f = (x: number) => x.toFixed(4);
  return [
    `${(total / 1000).toFixed(1)}s`,
    `底噪 ${f(startFloor ?? 0)}→${f(floor)}`,
    `保持线 ${f(holdBar(startFloor ?? 0, cuts))}→${f(holdBar(floor, cuts))}`,
    `她的声音 ${f(median(voiced))}`,
    `最后 ${(endWaitMs / 1000).toFixed(1)}s ${f(median(tail))}`,
  ].join(" · ");
}
