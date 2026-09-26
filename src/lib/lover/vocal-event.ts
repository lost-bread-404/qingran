import { glueCueParts, hasCueEnergy, markForFrames, voicedIslands, type Island, type ProsodyFrame } from "./prosody.ts";

export type VocalKind = "speech" | "laugh" | "cry" | "pant" | "hum" | "vocal" | "none";

export type VocalEvent = {
  kind: VocalKind;
  text: string;
};

function avg(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

function cv(values: number[]) {
  if (values.length < 2) return 1;
  const mean = avg(values);
  if (mean <= 0) return 1;
  const variance = avg(values.map((n) => (n - mean) ** 2));
  return Math.sqrt(variance) / mean;
}

function islandFalling(island: Island) {
  const rms = island.frames.map((f) => f.rms);
  const third = Math.max(1, Math.ceil(rms.length / 3));
  const head = avg(rms.slice(0, third));
  const tail = avg(rms.slice(-third));
  return head > 0 && tail < head * 0.82;
}

export function islandVoiced(island: Island) {
  const frames = island.frames;
  if (!frames.length) return false;
  const voiced = frames.filter((f) => f.hz > 80 && f.clarity >= 0.65).length;
  return voiced / frames.length >= 0.4;
}

export function renderBursts(char: string, islands: Island[]) {
  if (!islands.length) return "";
  const parts: string[] = [];
  for (let i = 0; i < islands.length; i += 1) {
    const island = islands[i]!;
    const dur = island.end - island.start;
    const n = dur >= 0.28 ? 2 : 1;
    let mark = markForFrames(island.frames);
    const next = islands[i + 1];
    if (!mark && next && next.start - island.end >= 0.1) mark = "…";
    parts.push(`${char.repeat(n)}${mark}`);
  }
  return glueCueParts(parts, islands, char === "哈");
}

export function listenVocal(frames: ProsodyFrame[]): VocalEvent {
  if (!frames.length || !hasCueEnergy(frames)) return { kind: "none", text: "" };
  const islands = voicedIslands(frames);
  if (!islands.length) return { kind: "none", text: "" };

  const durs = islands.map((island) => Math.max(0.04, island.end - island.start));
  const gaps = islands.slice(1).map((island, i) => Math.max(0, island.start - islands[i]!.end));
  const meanDur = avg(durs);
  const meanGap = avg(gaps);
  const meanClarity = avg(islands.flatMap((island) => island.frames.map((f) => f.clarity)));
  const meanBright = avg(islands.flatMap((island) => island.frames.map((f) => f.bright)));
  const peak = Math.max(0, ...islands.flatMap((island) => island.frames.map((f) => f.rms)));
  const voicedShare = islands.filter(islandVoiced).length / islands.length;
  const fallingShare = islands.filter(islandFalling).length / islands.length;
  const n = islands.length;
  const period = meanDur + (n >= 2 ? meanGap : 0.2);
  const rate = period > 0 ? 1 / period : 0;
  const regular = n >= 3 && cv(durs) < 0.55 && (gaps.length < 2 || cv(gaps) < 0.7);

  const laugh =
    n >= 3 &&
    rate >= 3.3 &&
    meanDur <= 0.2 &&
    meanDur >= 0.04 &&
    regular &&
    meanClarity < 0.8;

  const cry =
    !laugh &&
    fallingShare >= 0.6 &&
    meanDur >= 0.18 &&
    meanBright < 0.22 &&
    voicedShare >= 0.35;

  const hum =
    !laugh &&
    !cry &&
    voicedShare >= 0.7 &&
    meanClarity >= 0.82 &&
    meanBright < 0.2 &&
    meanDur >= 0.12;

  const pant =
    !laugh &&
    !cry &&
    !hum &&
    n >= 3 &&
    voicedShare <= 0.35 &&
    meanDur <= 0.36 &&
    meanDur >= 0.08 &&
    meanBright >= 0.16 &&
    peak >= 0.028 &&
    meanGap >= 0.1 &&
    meanGap <= 0.6;

  if (laugh) return { kind: "laugh", text: renderBursts("哈", islands) };
  if (cry) return { kind: "cry", text: renderBursts("呜", islands) };
  if (hum) return { kind: "hum", text: renderBursts("嗯", islands) };
  if (pant) return { kind: "pant", text: renderBursts("啊", islands) };
  if (n >= 2) return { kind: "vocal", text: "" };
  return { kind: "vocal", text: "" };
}

