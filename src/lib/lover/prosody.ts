export type ProsodyFrame = {
  t: number;
  rms: number;
  hz: number;
  clarity: number;
  centroid: number;
  bright: number;
};

export type CueWord = {
  text?: string;
  start?: number;
  end?: number;
};

export type CueKind = "嗯" | "啊" | "呜" | "嗷" | "哼" | "哈";

type Island = {
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
  for (let i = 1; i < n; i += 1) {
    const v = freq[i] ?? 0;
    if (!v) continue;
    const hz = i * binHz;
    mag += v;
    weighted += v * hz;
    if (hz >= 1100) high += v;
  }
  return {
    centroid: mag ? weighted / mag : 0,
    bright: mag ? high / mag : 0,
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

  let bestTau = 0;
  let best = 0;
  for (let tau = tauMin; tau <= tauMax; tau += 1) {
    let ac = 0;
    let m = 0;
    const last = n - tau;
    for (let i = 0; i < last; i += 2) {
      const a = buf[i]!;
      const b = buf[i + tau]!;
      ac += a * b;
      m += a * a + b * b;
    }
    const nsdf = m ? (2 * ac) / m : 0;
    if (nsdf > best) {
      best = nsdf;
      bestTau = tau;
    }
  }
  if (!bestTau || best < 0.62) return { hz: 0, clarity: best };
  return { hz: sampleRate / bestTau, clarity: best };
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
  const pitch = needPitch && rms >= 0.01 ? pitchWithClarity(time, sampleRate) : { hz: 0, clarity: 0 };
  return {
    t,
    rms,
    hz: pitch.hz,
    clarity: pitch.clarity,
    centroid: shape.centroid,
    bright: shape.bright,
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

export function markForFrames(frames: ProsodyFrame[]): "…" | "～" | "！" | "" {
  if (frames.length < 2) return "";
  const dur = (frames[frames.length - 1]?.t ?? 0) - (frames[0]?.t ?? 0);
  const rms = frames.map((f) => f.rms);
  const hz = frames.filter((f) => f.hz > 80 && f.clarity >= 0.68).map((f) => f.hz);
  const third = Math.max(1, Math.ceil(rms.length / 3));
  const head = avg(rms.slice(0, third));
  const tail = avg(rms.slice(-third));
  const peak = Math.max(...rms);
  const mean = avg(rms);
  const span = hz.length >= 3 ? Math.max(...hz) - Math.min(...hz) : 0;
  const mid = avg(hz);
  const glide = mid > 0 && span / mid >= 0.07;
  if (dur <= 0.24 && peak >= 0.08) return "！";
  if (peak > Math.max(0.04, mean * 1.55) && dur <= 0.32) return "！";
  if (glide && dur >= 0.16) return "～";
  if ((tail < head * 0.72 && dur >= 0.22) || dur >= 0.42) return "…";
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
  const breathy = unvoicedRatio >= 0.5 && peak >= 0.016 && (bright >= 0.16 || centroid >= 600);
  const sob =
    falling &&
    dur >= 0.16 &&
    midHz > 0 &&
    midHz < 320 &&
    bright < 0.36 &&
    peak < 0.11;

  if (breathy) return "哈";
  if (sob) return "呜";
  if (bright >= 0.3 || centroid >= 980 || (peak >= 0.07 && centroid >= 720)) return "啊";
  if (hum && dur >= 0.12 && !falling) return "嗯";
  if (
    dur <= 0.38 &&
    peak < 0.085 &&
    centroid < 1000 &&
    bright < 0.32 &&
    !hum &&
    (clarity < 0.8 || falling || dur <= 0.18)
  ) {
    return "哼";
  }
  if (hum || (bright < 0.2 && centroid < 720 && peak < 0.055 && rms < 0.04)) return "嗯";
  if (centroid < 1080 && bright < 0.38) return "呜";
  if (rising && (bright >= 0.25 || centroid >= 850) && peak >= 0.04) return "嗷";
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

export function cuesFromProsody(frames: ProsodyFrame[]): string {
  const islands = voicedIslands(frames);
  if (!islands.length) return "";
  const parts: string[] = [];
  for (let i = 0; i < islands.length; i += 1) {
    const island = islands[i]!;
    const cue = classifyCue(island.frames);
    const dur = island.end - island.start;
    const n = cueRepeat(cue, dur);
    let mark = markForFrames(island.frames);
    const next = islands[i + 1];
    if (!mark && next && next.start - island.end >= 0.1) mark = "…";
    parts.push(`${cue.repeat(n)}${mark}`);
  }
  return parts.join("");
}

function cueRepeat(kind: CueKind, dur: number) {
  if (kind === "哼" || kind === "嗷") return 1;
  if (kind === "哈") return dur >= 0.38 ? 2 : 1;
  if (kind === "呜") return dur >= 0.2 ? 2 : 1;
  if (dur >= 0.5) return 2;
  return 1;
}
