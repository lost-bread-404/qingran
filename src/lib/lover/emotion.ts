import { voicedIslands, type ProsodyFrame } from "./prosody.ts";

export type VoiceFeel = "sajiao" | "sad" | "hot" | "laugh" | "breathy" | "calm";

function avg(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

function cv(values: number[]) {
  if (values.length < 2) return 0;
  const mean = avg(values);
  if (mean <= 0) return 0;
  return Math.sqrt(avg(values.map((n) => (n - mean) ** 2))) / mean;
}

export function feelFromFrames(frames: ProsodyFrame[]): VoiceFeel {
  if (!frames.length) return "calm";
  const islands = voicedIslands(frames);
  if (!islands.length) return "calm";

  const voiced = frames.filter((f) => f.hz > 80 && f.clarity >= 0.6);
  const hz = voiced.map((f) => f.hz);
  const third = Math.max(1, Math.ceil(hz.length / 3));
  const startHz = avg(hz.slice(0, third));
  const endHz = avg(hz.slice(-third));
  const rise = startHz > 80 ? endHz / startHz : 1;

  const rms = frames.map((f) => f.rms);
  const rThird = Math.max(1, Math.ceil(rms.length / 3));
  const head = avg(rms.slice(0, rThird));
  const tail = avg(rms.slice(-rThird));
  const fallingEnergy = head > 0 && tail < head * 0.78;
  const peak = Math.max(...rms, 0);
  const meanBright = avg(frames.map((f) => f.bright));
  const meanClarity = avg(voiced.map((f) => f.clarity));
  const loud = frames.filter((f) => f.rms >= 0.006);
  const voicedShare = voiced.length / Math.max(1, loud.length);

  const durs = islands.map((island) => Math.max(0.04, island.end - island.start));
  const meanDur = avg(durs);
  const n = islands.length;
  const meanGap =
    n >= 2 ? avg(islands.slice(1).map((island, i) => Math.max(0, island.start - islands[i]!.end))) : 0.2;
  const rate = meanDur + meanGap > 0 ? 1 / (meanDur + (n >= 2 ? meanGap : 0.2)) : 0;
  const jitter = cv(hz);

  if (n >= 3 && rate >= 3.2 && meanDur <= 0.2 && meanClarity < 0.8) return "laugh";
  if (fallingEnergy && rise <= 0.96 && meanBright < 0.24 && meanDur >= 0.16) return "sad";
  if (voicedShare <= 0.35 && n >= 3 && meanBright >= 0.16 && meanDur <= 0.36) return "breathy";
  if (rise >= 1.08 && peak < 0.12) return "sajiao";
  if (peak >= 0.1 && meanDur <= 0.26 && rise < 1.04) return "hot";
  if (rise >= 1.05 && jitter < 0.22) return "sajiao";
  if (fallingEnergy && rise < 1) return "sad";
  return "calm";
}

const SAJIAO_TAIL = /[嘛啦呢呀哦噢嗯啊吧]$/;

export function applyFeelToText(text: string, feel: VoiceFeel): string {
  const raw = text.trim();
  if (!raw || feel === "calm" || feel === "laugh" || feel === "breathy") return raw;
  const core = raw.replace(/[。！？～…]+$/g, "");
  if (!core) return raw;
  const filler = [...core.replace(/[，,\s]+/g, "")].every((ch) =>
    /[嗯唔呜啊哦噢喔额呃唉哎诶欸哼哈嘿哇呀哟呦嘛呢吧啦咯嘞嘤喵嗷呼嘻嗨]$/.test(ch),
  );
  const tailOk = filler || SAJIAO_TAIL.test(core);

  if (feel === "sajiao") {
    if (!tailOk) return raw;
    if (/[～]$/.test(raw)) return raw;
    return `${core}～`;
  }
  if (feel === "sad") {
    if (!tailOk) return raw;
    if (/[…～]$/.test(raw)) return raw;
    return `${core}…`;
  }
  if (feel === "hot") {
    if (!filler) return raw;
    if (/[！]$/.test(raw)) return raw;
    return `${core}！`;
  }
  return raw;
}
