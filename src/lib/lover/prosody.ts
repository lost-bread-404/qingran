export type ProsodyFrame = {
  t: number;
  rms: number;
  hz: number;
  clarity: number;
  centroid: number;
  bright: number;
  tilt?: number;
};

export type CueWord = {
  text?: string;
  start?: number;
  end?: number;
};

export type CueKind = "嗯" | "啊" | "呜" | "嗷" | "哼" | "哈";

export type Island = {
  start: number;
  end: number;
  frames: ProsodyFrame[];
};

export function spectralShape(freq: Uint8Array, sampleRate: number) {
  const n = freq.length;
  const binHz = sampleRate / 2 / Math.max(1, n);
  let mag = 0;
  let weighted = 0;
  let high = 0;
  let low = 0;
  for (let i = 1; i < n; i += 1) {
    const v = freq[i] ?? 0;
    if (!v) continue;
    const hz = i * binHz;
    mag += v;
    weighted += v * hz;
    if (hz >= 1100) high += v;
    else if (hz <= 400) low += v;
  }
  return {
    centroid: mag ? weighted / mag : 0,
    bright: mag ? high / mag : 0,
    tilt: mag ? (low - high) / mag : 0,
  };
}

function rmsFromTimeDomain(data: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) {
    const v = ((data[i] ?? 128) - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / Math.max(1, data.length));
}

export function pitchWithClarity(data: Uint8Array, sampleRate: number) {
  const n = Math.min(data.length, 1024);
  if (n < 80) return { hz: 0, clarity: 0 };
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i += 1) buf[i] = ((data[i] ?? 128) - 128) / 128;
  const tauMin = Math.max(2, Math.floor(sampleRate / 520));
  const tauMax = Math.min(Math.floor(n / 2) - 2, Math.floor(sampleRate / 70));
  if (tauMax <= tauMin + 4) return { hz: 0, clarity: 0 };

  const nsdfAt = (tau: number) => {
    let ac = 0;
    let m = 0;
    const last = n - tau;
    for (let i = 0; i < last; i += 2) {
      const a = buf[i]!;
      const b = buf[i + tau]!;
      ac += a * b;
      m += a * a + b * b;
    }
    return m ? (2 * ac) / m : 0;
  };

  let bestTau = 0;
  let best = 0;
  for (let tau = tauMin; tau <= tauMax; tau += 1) {
    const nsdf = nsdfAt(tau);
    if (nsdf > best) {
      best = nsdf;
      bestTau = tau;
    }
  }
  if (!bestTau || best < 0.58) return { hz: 0, clarity: best };

  const prev = bestTau > tauMin ? nsdfAt(bestTau - 1) : best;
  const next = bestTau < tauMax ? nsdfAt(bestTau + 1) : best;
  const denom = 2 * (prev - 2 * best + next);
  const shift = denom !== 0 ? (prev - next) / denom : 0;
  const tau = bestTau + Math.max(-1, Math.min(1, shift));
  return { hz: sampleRate / tau, clarity: best };
}

export function pitchFromTimeDomain(data: Uint8Array, sampleRate: number): number {
  return pitchWithClarity(data, sampleRate).hz;
}

export function sampleProsody(
  analyser: AnalyserNode,
  sampleRate: number,
  t: number,
  needPitch: boolean,
): ProsodyFrame {
  const time = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(time);
  const rms = rmsFromTimeDomain(time);
  const freq = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(freq);
  const shape = spectralShape(freq, sampleRate);
  const pitch = needPitch && rms >= 0.008 ? pitchWithClarity(time, sampleRate) : { hz: 0, clarity: 0 };
  return {
    t,
    rms,
    hz: pitch.hz,
    clarity: pitch.clarity,
    centroid: shape.centroid,
    bright: shape.bright,
    tilt: shape.tilt,
  };
}

export function voicedIslands(frames: ProsodyFrame[]): Island[] {
  const coarse: Island[] = [];
  let cur: ProsodyFrame[] = [];
  for (const frame of frames) {
    const on = cur.length ? frame.rms >= 0.0038 : frame.rms >= 0.0065;
    if (on) {
      cur.push(frame);
      continue;
    }
    if (cur.length) {
      pushIsland(coarse, cur);
      cur = [];
    }
  }
  if (cur.length) pushIsland(coarse, cur);
  return coarse.flatMap(splitDips);
}

export function hasCueEnergy(frames: ProsodyFrame[]): boolean {
  const islands = voicedIslands(frames);
  if (!islands.length) return false;
  const dur = islands.reduce((sum, island) => sum + Math.max(0, island.end - island.start), 0);
  const peak = Math.max(0, ...frames.map((f) => f.rms));
  return dur >= 0.1 && peak >= 0.018;
}

function pushIsland(islands: Island[], frames: ProsodyFrame[]) {
  const start = frames[0]?.t ?? 0;
  const end = frames[frames.length - 1]?.t ?? start;
  if (end - start < 0.04) return;
  islands.push({ start, end, frames });
}

function splitDips(island: Island): Island[] {
  const frames = island.frames;
  if (frames.length < 8) return [island];
  const peak = Math.max(...frames.map((f) => f.rms), 0);
  const cut = Math.max(0.0042, peak * 0.34);
  const cuts: number[] = [];
  let lowStart = -1;
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i]!;
    if (frame.rms < cut) {
      if (lowStart < 0) lowStart = i;
      continue;
    }
    if (lowStart >= 0) {
      const dip = frame.t - (frames[lowStart]?.t ?? frame.t);
      if (dip >= 0.055 && lowStart > 0) cuts.push(lowStart);
      lowStart = -1;
    }
  }
  if (!cuts.length) return [island];
  const parts: Island[] = [];
  let from = 0;
  for (const at of cuts) {
    pushIsland(parts, frames.slice(from, at));
    from = at;
    while (from < frames.length && (frames[from]?.rms ?? 0) < cut) from += 1;
  }
  pushIsland(parts, frames.slice(from));
  return parts.length ? parts : [island];
}

function avg(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

export type ToneThresholds = {
  glideRatio: number;
  riseQuestion: number;
  fadeRatio: number;
  longDur: number;
  waveDur: number;
  bangPeak: number;
  bangDur: number;
  voicedClarity: number;
  /** |end/start − 1| within this adds no mark and skips the other marks. 0 disables it. */
  flatZone?: number;
  /** False turns every mark off. Omitted means on, so older callers keep their punctuation. */
  marks?: boolean;
};

export const DEFAULT_TONE_THRESHOLDS: ToneThresholds = {
  glideRatio: 0.055,
  riseQuestion: 1.18,
  fadeRatio: 0.72,
  longDur: 0.42,
  waveDur: 0.16,
  bangPeak: 0.08,
  bangDur: 0.24,
  voicedClarity: 0.68,
};

export type StoredProsody = {
  hopMs: number;
  rms: number[];
  hz: number[];
  clarity: number[];
  centroid: number[];
  bright: number[];
};

export const PROSODY_HOP_MS = 40;

function marksOn(th: ToneThresholds): boolean {
  return th.marks !== false;
}

export type ToneReading = {
  riseRatio: number | null;
  glide: number | null;
  fade: number | null;
  peak: number | null;
  mark: "" | "？" | "～" | "…" | "！";
};

function pitchEnds(hz: number[]): { start: number; end: number } | null {
  if (hz.length < 4) return null;
  const third = Math.max(1, Math.ceil(hz.length / 3));
  const start = avg(hz.slice(0, third));
  const end = avg(hz.slice(-third));
  if (!(start > 80) || !(end > 0)) return null;
  return { start, end };
}

function isFlatPitch(ratio: number | null, flatZone: number | undefined): boolean {
  if (ratio == null || !flatZone || flatZone <= 0) return false;
  return Math.abs(ratio - 1) <= flatZone;
}

export function readTone(frames: ProsodyFrame[], th: ToneThresholds = DEFAULT_TONE_THRESHOLDS): ToneReading {
  if (frames.length < 2) {
    return { riseRatio: null, glide: null, fade: null, peak: null, mark: "" };
  }
  const rms = frames.map((f) => f.rms);
  const hz = frames.filter((f) => f.hz > 80 && f.clarity >= th.voicedClarity).map((f) => f.hz);
  const third = Math.max(1, Math.ceil(rms.length / 3));
  const head = avg(rms.slice(0, third));
  const tail = avg(rms.slice(-third));
  const peak = Math.max(...rms, 0);
  const span = hz.length >= 3 ? Math.max(...hz) - Math.min(...hz) : 0;
  const mid = avg(hz);
  const ends = pitchEnds(hz);
  const riseRatio = ends ? ends.end / ends.start : null;
  const glide = mid > 0 ? span / mid : null;
  const fade = head > 0 ? tail / head : null;
  return {
    riseRatio,
    glide,
    fade,
    peak,
    mark: utteranceToneMark(frames, th),
  };
}

export function markForFrames(
  frames: ProsodyFrame[],
  th: ToneThresholds = DEFAULT_TONE_THRESHOLDS,
): "…" | "～" | "！" | "" {
  if (!marksOn(th) || frames.length < 2) return "";
  const dur = (frames[frames.length - 1]?.t ?? 0) - (frames[0]?.t ?? 0);
  const rms = frames.map((f) => f.rms);
  const hz = frames.filter((f) => f.hz > 80 && f.clarity >= th.voicedClarity).map((f) => f.hz);
  const third = Math.max(1, Math.ceil(rms.length / 3));
  const head = avg(rms.slice(0, third));
  const tail = avg(rms.slice(-third));
  const peak = Math.max(...rms);
  const span = hz.length >= 3 ? Math.max(...hz) - Math.min(...hz) : 0;
  const mid = avg(hz);
  const ends = pitchEnds(hz);
  const riseRatio = ends ? ends.end / ends.start : null;
  if (isFlatPitch(riseRatio, th.flatZone)) return "";
  const glide = mid > 0 && span / mid >= th.glideRatio;
  const tilt = avg(frames.map((f) => f.tilt ?? 0));
  if (dur <= th.bangDur && peak >= th.bangPeak) return "！";
  if (glide && dur >= th.waveDur) return "～";
  if (dur >= th.waveDur && tail >= head * 0.86 && peak <= th.bangPeak && tilt >= 0) return "～";
  if (head > 0 && tail < head * th.fadeRatio && dur >= 0.22) return "…";
  return "";
}

export function classifyCue(frames: ProsodyFrame[]): CueKind {
  const dur = (frames[frames.length - 1]?.t ?? 0) - (frames[0]?.t ?? 0);
  const rms = avg(frames.map((f) => f.rms));
  const peak = Math.max(...frames.map((f) => f.rms), 0);
  const centroid = avg(frames.map((f) => f.centroid).filter((n) => n > 0));
  const bright = avg(frames.map((f) => f.bright));
  const clarity = avg(frames.map((f) => f.clarity).filter((n) => n > 0));
  const voiced = frames.filter((f) => f.hz > 80 && f.clarity >= 0.65);
  const hzVals = voiced.map((f) => f.hz).sort((a, b) => a - b);
  const midHz = hzVals[Math.floor(hzVals.length / 2)] ?? 0;
  const stable = hzVals.filter((h) => midHz && h > midHz * 0.78 && h < midHz * 1.28);
  const third = Math.max(1, Math.ceil(frames.length / 3));
  const head = avg(frames.slice(0, third).map((f) => f.rms));
  const tail = avg(frames.slice(-third).map((f) => f.rms));
  const falling = tail < head * 0.82;
  const hum = clarity >= 0.82 && bright < 0.18 && centroid > 0 && centroid < 720;
  const startHz = avg(stable.slice(0, Math.max(1, Math.ceil(stable.length / 3))));
  const endHz = avg(stable.slice(-Math.max(1, Math.ceil(stable.length / 3))));
  const rising = startHz > 80 && endHz / startHz >= 1.15 && dur >= 0.22;
  const unvoicedRatio = 1 - voiced.length / Math.max(1, frames.length);
  const closed = (centroid > 0 && centroid < 740 && bright < 0.22) || hum;
  const open = bright >= 0.26 || centroid >= 920 || (peak >= 0.06 && centroid >= 700);
  const laugh =
    unvoicedRatio >= 0.72 &&
    dur <= 0.16 &&
    peak >= 0.1 &&
    bright >= 0.34 &&
    centroid >= 1200 &&
    !falling;

  if (
    falling &&
    dur >= 0.16 &&
    peak < 0.12 &&
    bright < 0.36 &&
    !open
  ) {
    if (midHz > 80 && midHz < 310) return "呜";
    if (unvoicedRatio >= 0.4 && centroid > 0 && centroid < 880) return "呜";
  }
  if (closed && !open) {
    if (dur <= 0.16 && peak < 0.065 && !hum) return "哼";
    return "嗯";
  }
  if (laugh) return "哈";
  if (rising && open && peak >= 0.05 && dur >= 0.22) return "嗷";
  if (open || unvoicedRatio >= 0.4) return "啊";
  if (hum || (bright < 0.2 && centroid < 720 && peak < 0.055 && rms < 0.04)) return "嗯";
  if (centroid < 1080 && bright < 0.38 && falling) return "呜";
  return "啊";
}

export function leadingCueFrames(frames: ProsodyFrame[]): ProsodyFrame[] | null {
  const islands = voicedIslands(frames);
  const first = islands[0];
  if (!first) return null;
  const dur = first.end - first.start;
  if (dur <= 0.45) return first.frames;
  if (islands[1] && islands[1].start - first.end >= 0.1) return first.frames;
  return first.frames.filter((f) => f.t <= first.start + 0.28);
}

export function glueCueParts(parts: string[], islands: Island[], tight = false) {
  if (!parts.length) return "";
  if (parts.length === 1 || tight) return parts.join("");
  let out = parts[0] ?? "";
  for (let i = 1; i < parts.length; i += 1) {
    const gap = Math.max(0, (islands[i]?.start ?? 0) - (islands[i - 1]?.end ?? 0));
    const prev = out;
    const next = parts[i] ?? "";
    const sep = prev.endsWith("…") || next.startsWith("…") || gap < 0.08 ? "" : "，";
    out += `${sep}${next}`;
  }
  return out;
}

export function cuesFromProsody(frames: ProsodyFrame[], th: ToneThresholds = DEFAULT_TONE_THRESHOLDS): string {
  const islands = voicedIslands(frames);
  if (!islands.length) return "";
  const parts: string[] = [];
  for (let i = 0; i < islands.length; i += 1) {
    const island = islands[i]!;
    const cue = classifyCue(island.frames);
    const dur = island.end - island.start;
    const n = cueRepeat(cue, dur);
    let mark = markForFrames(island.frames, th);
    const next = islands[i + 1];
    if (marksOn(th) && !mark && next && next.start - island.end >= 0.1) mark = "…";
    parts.push(`${cue.repeat(n)}${mark}`);
  }
  return glueCueParts(parts, islands, parts.every((part) => part.startsWith("哈")));
}

function cueRepeat(kind: CueKind, dur: number) {
  if (kind === "哼" || kind === "嗷") return 1;
  if (kind === "哈") return dur >= 0.28 ? 2 : 1;
  if (kind === "呜") return dur >= 0.2 ? 2 : 1;
  if (dur >= 0.28) return 2;
  return 1;
}

export function hasVoicedPitch(frames: ProsodyFrame[]): boolean {
  return frames.some((f) => f.hz > 80 && f.clarity >= 0.65 && f.rms >= 0.01);
}

export function utteranceToneMark(
  frames: ProsodyFrame[],
  th: ToneThresholds = DEFAULT_TONE_THRESHOLDS,
): "～" | "…" | "？" | "！" | "" {
  if (!marksOn(th)) return "";
  const islands = voicedIslands(frames);
  const last = islands[islands.length - 1];
  if (!last) return "";
  const hz = last.frames.filter((f) => f.hz > 80 && f.clarity >= th.voicedClarity).map((f) => f.hz);
  const ends = pitchEnds(hz);
  const ratio = ends ? ends.end / ends.start : null;
  if (isFlatPitch(ratio, th.flatZone)) return "";
  if (ratio != null && ratio >= th.riseQuestion) return "？";
  return markForFrames(last.frames, th);
}

export function downsampleProsody(frames: ProsodyFrame[], hopMs = PROSODY_HOP_MS): StoredProsody {
  const hop = Math.max(20, hopMs) / 1000;
  const rms: number[] = [];
  const hz: number[] = [];
  const clarity: number[] = [];
  const centroid: number[] = [];
  const bright: number[] = [];
  if (!frames.length) return { hopMs, rms, hz, clarity, centroid, bright };
  const start = frames[0]?.t ?? 0;
  const end = frames[frames.length - 1]?.t ?? start;
  for (let t = start; t <= end + 1e-6; t += hop) {
    const slice = frames.filter((f) => f.t >= t - hop / 2 && f.t < t + hop / 2);
    const used = slice.length ? slice : nearestFrame(frames, t);
    rms.push(round4(avg(used.map((f) => f.rms))));
    const voiced = used.filter((f) => f.hz > 80);
    hz.push(Math.round(avg(voiced.map((f) => f.hz))));
    clarity.push(round4(avg(used.map((f) => f.clarity))));
    centroid.push(Math.round(avg(used.map((f) => f.centroid))));
    bright.push(round4(avg(used.map((f) => f.bright))));
  }
  return { hopMs, rms, hz, clarity, centroid, bright };
}

export function framesFromStored(stored: StoredProsody | null | undefined): ProsodyFrame[] {
  if (!stored?.rms?.length) return [];
  const hop = Math.max(1, stored.hopMs || PROSODY_HOP_MS) / 1000;
  return stored.rms.map((rms, i) => ({
    t: i * hop,
    rms: rms || 0,
    hz: stored.hz?.[i] ?? 0,
    clarity: stored.clarity?.[i] ?? 0,
    centroid: stored.centroid?.[i] ?? 0,
    bright: stored.bright?.[i] ?? 0,
  }));
}

export function parseStoredProsody(value: unknown): StoredProsody | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.rms)) return null;
  return {
    hopMs: Number(row.hopMs) || PROSODY_HOP_MS,
    rms: row.rms.map((n) => Number(n) || 0),
    hz: Array.isArray(row.hz) ? row.hz.map((n) => Number(n) || 0) : [],
    clarity: Array.isArray(row.clarity) ? row.clarity.map((n) => Number(n) || 0) : [],
    centroid: Array.isArray(row.centroid) ? row.centroid.map((n) => Number(n) || 0) : [],
    bright: Array.isArray(row.bright) ? row.bright.map((n) => Number(n) || 0) : [],
  };
}

export function prosodyFromSamples(
  samples: Float32Array,
  sampleRate: number,
  hopMs = PROSODY_HOP_MS,
): StoredProsody {
  const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
  const win = Math.max(hop, Math.round(sampleRate * 0.04));
  const frames: ProsodyFrame[] = [];
  for (let i = 0; i + 80 < samples.length; i += hop) {
    const n = Math.min(win, samples.length - i);
    const time = new Uint8Array(n);
    const slice = new Float32Array(n);
    for (let k = 0; k < n; k += 1) {
      const v = samples[i + k] ?? 0;
      slice[k] = v;
      time[k] = Math.max(0, Math.min(255, Math.round(v * 128 + 128)));
    }
    let sum = 0;
    for (let k = 0; k < n; k += 1) {
      const v = ((time[k] ?? 128) - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / Math.max(1, n));
    const pitch = rms >= 0.008 ? pitchWithClarity(time, sampleRate) : { hz: 0, clarity: 0 };
    const shape = cheapSpectrum(slice, sampleRate);
    frames.push({
      t: i / sampleRate,
      rms,
      hz: pitch.hz,
      clarity: pitch.clarity,
      centroid: shape.centroid,
      bright: shape.bright,
      tilt: shape.tilt,
    });
  }
  return downsampleProsody(frames, hopMs);
}

function nearestFrame(frames: ProsodyFrame[], t: number): ProsodyFrame[] {
  let best = frames[0];
  let dist = Infinity;
  for (const frame of frames) {
    const d = Math.abs(frame.t - t);
    if (d < dist) {
      dist = d;
      best = frame;
    }
  }
  return best ? [best] : [];
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function cheapSpectrum(buf: Float32Array, sampleRate: number) {
  const n = Math.min(128, buf.length);
  if (n < 16) return { centroid: 0, bright: 0, tilt: 0 };
  const binHz = sampleRate / n;
  let mag = 0;
  let weighted = 0;
  let high = 0;
  let low = 0;
  for (let k = 1; k < n / 2; k += 1) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i += 2) {
      const ang = (2 * Math.PI * k * i) / n;
      const v = buf[i] ?? 0;
      re += v * Math.cos(ang);
      im -= v * Math.sin(ang);
    }
    const v = Math.hypot(re, im);
    const hz = k * binHz;
    mag += v;
    weighted += v * hz;
    if (hz >= 1100) high += v;
    else if (hz <= 400) low += v;
  }
  return {
    centroid: mag ? weighted / mag : 0,
    bright: mag ? high / mag : 0,
    tilt: mag ? (low - high) / mag : 0,
  };
}

