import { classifyCue, cuesFromProsody, glueCueParts, markForFrames, voicedIslands, type CueWord, type ProsodyFrame } from "./prosody.ts";
import { islandVoiced, listenVocal } from "./vocal-event.ts";

export const STT_KEYTERMS = [
  "嗯",
  "啊",
  "呜",
  "哈",
  "哼",
  "嗷",
  "哦",
  "唉",
  "嘛",
  "呀",
  "啦",
  "呢",
  "吧",
  "喵",
  "嗯嗯",
  "嗯嗯嗯",
  "啊啊",
  "呜呜",
  "哈哈",
  "喵喵",
  "清然",
  "Rosie",
  "姐姐",
  "小猫",
  "林泽",
];

const ABO_TERMS = [
  "ABO",
  "Alpha",
  "Omega",
  "Beta",
  "alpha",
  "omega",
  "beta",
  "信息素",
  "标记",
  "腺体",
  "发情",
  "发情期",
  "热潮",
  "结合热",
  "安抚",
  "信香",
  "分化",
];

const CUE_CHARS = "嗯唔呜啊哦噢喔额呃唉哎诶欸哼哈嘿哇呀哟呦切啧嘶嘛呢吧啦咯嘞嘤喵嗷呼嘻嗨嘘咿欧咕唧呐欸喔哇";
const FILLER = new RegExp(`[${CUE_CHARS}]`);
const CUE_RUN = new RegExp(`[${CUE_CHARS}]+`, "g");

type SttWord = { text?: string; start?: number; end?: number };

export function stripMarks(text: string): string {
  return text.replace(/[，。！？、,.!?;；：:\s………~～"'“”‘’]+/g, "");
}

export function restoreSpeechText(raw: string, words?: SttWord[]): string {
  const fromWords = words?.length ? stitchWords(words) : "";
  const a = collapseRepeats(punctuateSpeech(collapseRepeats(softenCue(fromWords))));
  const b = collapseRepeats(punctuateSpeech(collapseRepeats(softenCue(raw))));
  if (a && b) {
    const sa = stripMarks(a);
    const sb = stripMarks(b);
    if (sa === sb || sa.includes(sb) || sb.includes(sa)) {
      return sa.length >= sb.length ? a : b;
    }
    return a.length >= b.length ? a : b;
  }
  return a || b;
}

function softenCue(raw: string): string {
  let text = raw.replace(/\s+/g, " ").trim();
  if (!text) return "";
  text = text.replace(/呵+/g, "");
  const core = stripMarks(text);
  const mapped = mapVocalization(core);
  if (mapped) return mapped;
  if (core.length > 16) return text;
  text = text.replace(/恩/g, "嗯").replace(/阿/g, "啊").replace(/亨/g, "哼");
  if (/^(miao+|meow+)$/i.test(core)) return "喵";
  if (/^(喵呜*|喵喵+)$/.test(core)) return core;
  return text;
}

function mapVocalization(core: string): string | null {
  if (!core) return null;
  if (/^(抽泣|哭|哭声|抽噎|啜泣|呜咽)$/.test(core)) return "呜呜";
  if (/^(喘气|喘息|气声|吸气)$/.test(core)) return "啊";
  const latin = core.replace(/[^A-Za-z]/g, "").toLowerCase();
  if (!latin) return null;
  const leftover = core.replace(/[A-Za-z]/g, "");
  if (leftover.replace(/[0-9]/g, "")) return null;
  if (latin.length > 40) return null;
  return mapLatinCues(latin);
}

function mapLatinCues(s: string): string | null {
  if (/^(ha){2,}$/.test(s)) return "哈".repeat(Math.min(4, Math.round(s.length / 2)));
  const tokens = s.match(
    /(?:miao+|meow+|sob+|crying|cry|sniffle|sniff+|pant+|huff+|phew|awoo+|woo+|wu+|ooh+|ahh+|aha+|ha+|hmm+|hnn+|mhm+|mmhm+|uhhuh|hum+|hmph+|heng+|ng+|en+|uh+|er+|um+|oh+|ao+|aa+h*|[hm]+)/g,
  );
  if (tokens && tokens.length >= 2) {
    const mapped = tokens.map((token) => mapOneLatinCue(token)).filter(Boolean);
    if (mapped.length >= 2) return mapped.join("");
  }
  return mapOneLatinCue(s);
}

function mapOneLatinCue(s: string): string | null {
  if (/^(miao+|meow+)$/.test(s)) return "喵";
  if (/^(sob+|cry|crying|sniff+|sniffle)$/.test(s)) return "呜呜";
  if (/^(pant+|huff+|phew)$/.test(s)) return "啊";
  if (/^(ha){2,}$/.test(s)) return "哈".repeat(Math.min(4, s.length / 2));
  if (/^ha$/.test(s) || /^h+a+$/.test(s)) return "啊";
  if (/^(ah)+$/.test(s)) return "啊".repeat(Math.min(4, Math.max(1, s.length / 2)));
  if (/^a+h*$/.test(s)) return "啊".repeat(s.length >= 6 ? 3 : s.length >= 4 ? 2 : 1);
  if (/^(woo+|wu+|ooh+)$/.test(s)) return "呜".repeat(s.length >= 6 ? 3 : s.length >= 4 ? 2 : 1);
  if (/^(awoo+|ao+)$/.test(s)) return "嗷";
  if (/^(hum+|hmph+|heng+)$/.test(s)) return "哼";
  if (/^(m+|hmm+|hnn+|mhm+|mmhm+|uhhuh|un+|ng+|en+)$/.test(s)) {
    return "嗯".repeat(Math.min(3, Math.max(1, Math.ceil(s.length / 4))));
  }
  if (/^(uh+|er+|um+)$/.test(s)) return "嗯";
  if (/^(oh+|o+)$/.test(s)) return "哦";
  return null;
}

function stitchWords(words: SttWord[]): string {
  const parts: string[] = [];
  let prevEnd: number | null = null;
  let prevStart: number | null = null;
  for (const word of words) {
    const token = (word.text ?? "").trim();
    if (!token) continue;
    const start = Number(word.start);
    if (prevEnd != null && Number.isFinite(start)) {
      if (start + 0.08 < prevEnd) continue;
      if (
        parts.length &&
        token === parts[parts.length - 1] &&
        prevStart != null &&
        Math.abs(start - prevStart) < 0.05
      ) {
        continue;
      }
      if (!isPunctToken(token)) {
        const gap = start - prevEnd;
        const last = parts[parts.length - 1] ?? "";
        if (!isPunctToken(last)) {
          const cueGap = isCueToken(last) && isCueToken(token);
          if (cueGap) {
            if (gap >= 0.45) parts.push("…");
          } else if (gap >= 1.05) parts.push("。");
          else if (gap >= 0.7) parts.push("，");
        }
      }
    }
    parts.push(token);
    const end = Number(word.end);
    if (Number.isFinite(end)) prevEnd = end;
    if (Number.isFinite(start)) prevStart = start;
  }
  return parts.join("");
}

export function punctuateSpeech(raw: string): string {
  let text = raw.replace(/\s+/g, " ").trim();
  if (!text) return "";
  text = text.replace(/~+/g, "～");

  if (isMostlyFiller(text)) return keepCuePunct(text);

  text = text
    .replace(/\.{2,}|…+/g, "……")
    .replace(/,{2,}/g, "，")
    .replace(/，{2,}/g, "，")
    .replace(/……{2,}/g, "……");

  text = text.replace(/吗(?!？)/g, "吗？");
  text = text.replace(/(是吧|对吧)(?!？)/g, "$1？");

  const bare = text.replace(/[，。！？……～\s]+$/g, "");
  if (/^(什么|怎么|为什么|哪|谁|几|何必)/.test(bare) || /[吗么呢]$/.test(bare)) {
    if (!/[？?]$/.test(text)) text = `${bare}？`;
  }

  if (!/[。！？……～]$/.test(text)) {
    if (/[吗么呢]$/.test(text)) text += "？";
    else text += "。";
  }

  return text
    .replace(/[，。]*([！？])+/g, "$1")
    .replace(/。{2,}/g, "。")
    .replace(/？。/g, "？")
    .replace(/！。/g, "！");
}

function keepCuePunct(text: string): string {
  let t = text.replace(/\s+/g, "");
  t = t.replace(/~+/g, "～").replace(/\.{2,}|…+/g, "…").replace(/,/g, "，").replace(/。+/g, "");
  t = t.replace(/，{2,}/g, "，").replace(/，(?=[～…！？])/g, "");
  return t;
}

function isCueToken(text: string): boolean {
  const core = stripMarks(text);
  return Boolean(core) && [...core].every((ch) => FILLER.test(ch));
}

export function needsPunctuationHelp(text: string): boolean {
  const t = text.trim();
  if (t.length < 24) return false;
  if (isMostlyFiller(t)) return false;
  const marks = t.match(/[，。！？、；：]/g)?.length ?? 0;
  return marks === 0 || marks < Math.max(1, Math.floor(stripMarks(t).length / 40));
}

export function extractKeyterms(prompt: string): string[] {
  const found = new Set<string>();
  const text = prompt ?? "";
  if (/ABO|信息素|alpha|omega|beta|腺体|发情|热潮/i.test(text)) {
    for (const term of ABO_TERMS) found.add(term);
  }
  for (const match of text.match(/[A-Z][a-zA-Z]{2,}/g) ?? []) found.add(match);
  for (const match of text.match(/[“「『"]([^“」』"]{2,12})[”」』"]/g) ?? []) {
    const inner = match.replace(/[“”「」『』"]/g, "").trim();
    if (inner.length >= 2 && inner.length <= 12) found.add(inner);
  }
  for (const match of text.match(/(?:叫|名叫|是)\s*([\u4e00-\u9fff]{2,4})/g) ?? []) {
    const name = match.replace(/^(?:叫|名叫|是)\s*/, "");
    if (name.length >= 2) found.add(name);
  }
  return [...found].filter((term) => term.length >= 2 && term.length <= 16).slice(0, 32);
}

export function sttKeyterms(prompt?: string): string[] {
  const extra = prompt ? extractKeyterms(prompt) : [];
  const all = [...extra, ...STT_KEYTERMS];
  return [...new Set(all)].slice(0, 100);
}

export function isMostlyFiller(text: string): boolean {
  const stripped = text.replace(/[，。！？……～~\s]/g, "");
  if (!stripped) return true;
  return [...stripped].every((ch) => FILLER.test(ch));
}

export function browserSttReady(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return !isMostlyFiller(t);
}

function isPunctToken(text: string): boolean {
  return /^[，。！？,.!?…]+$/.test(text);
}

export function pickSpokenAlt(alts: string[]): string {
  const cleaned = alts.map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (cleaned.length === 0) return "";
  for (const alt of cleaned) {
    const cue = softenCue(alt);
    const core = stripMarks(cue);
    if (core && [...core].every((ch) => FILLER.test(ch))) return cue;
  }
  return cleaned[0] ?? "";
}

export function hasFiller(text: string): boolean {
  return FILLER.test(text);
}

export function keepFillers(text: string): string {
  const bits = text.match(CUE_RUN);
  return bits ? bits.join("") : text;
}

function findRepeatUnit(s: string): string | null {
  const n = s.length;
  if (n < 6) return null;
  for (let size = 2; size <= Math.min(24, Math.floor(n / 2)); size += 1) {
    if (n % size !== 0) continue;
    const unit = s.slice(0, size);
    if (isMostlyFiller(unit)) continue;
    if (unit.repeat(n / size) === s) return unit;
  }
  return null;
}

function collapseClauses(text: string): string {
  const end = text.match(/[。！？……]+$/)?.[0] ?? "";
  const body = end ? text.slice(0, -end.length) : text;
  const parts = body.split(/[。！？]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return text;
  const out: string[] = [];
  for (const part of parts) {
    const prev = out[out.length - 1];
    if (prev && stripMarks(prev) === stripMarks(part) && stripMarks(part).length >= 3) continue;
    out.push(part);
  }
  if (out.length === parts.length) return text;
  return `${out.join("。")}${end || "。"}`;
}

export function collapseRepeats(text: string): string {
  let t = text.replace(/\s+/g, " ").trim();
  if (t.length < 4) return t;
  if (isMostlyFiller(t)) return t;
  t = collapseClauses(t);
  const stripped = stripMarks(t);
  const unit = findRepeatUnit(stripped);
  if (unit && unit.length >= 3) {
    const end = t.match(/[。！？……]+$/)?.[0] ?? "";
    return `${unit}${end}`;
  }
  return t;
}

export function mergeSpeech(prev: string, next: string): string {
  const a = prev.trim();
  const b = next.trim();
  if (!b) return a;
  if (!a) return punctuateSpeech(b);
  const na = stripMarks(a);
  const nb = stripMarks(b);
  if (!nb) return a;
  if (!na) return b;
  if (na === nb) return a.length >= b.length ? a : b;
  if (na.includes(nb)) return collapseRepeats(a);
  if (nb.includes(na)) return collapseRepeats(punctuateSpeech(b));
  const max = Math.min(na.length, nb.length);
  for (let k = max; k >= 2; k -= 1) {
    if (na.endsWith(nb.slice(0, k))) {
      return collapseRepeats(punctuateSpeech(na + nb.slice(k)));
    }
  }
  const left = a.replace(/[，。！？……]*$/, "");
  return collapseRepeats(punctuateSpeech(`${left}${b}`));
}

export function salvageCues(text: string): string {
  const bits = text.match(CUE_RUN);
  if (!bits?.length) return "";
  return bits.join("");
}

function leftoverMeaning(text: string): string {
  return stripMarks(text)
    .replace(/[（）()【】[\]{}]/g, "")
    .replace(/抽泣|咳嗽|咳|哭声|哭|鼻音|气声|喘气|喘息|抽噎|吸气/g, "");
}

function shouldKeepOnlyCues(text: string): boolean {
  const leftover = leftoverMeaning(text);
  if (!leftover) return Boolean(salvageCues(text));
  return [...leftover].every((ch) => FILLER.test(ch));
}

export function pickTranscript(server: string, browser: string): string {
  const mixed = `${browser} ${server}`.trim();
  if (isMostlyFiller(mixed)) return punctuateSpeech(mixed);
  if (shouldKeepOnlyCues(mixed) && salvageCues(mixed)) {
    return punctuateSpeech(salvageCues(mixed));
  }
  const a = collapseRepeats(softenCue(server.trim()));
  const b = collapseRepeats(softenCue(browser.trim()));
  const sb = stripMarks(b);
  const cueLike = Boolean(sb) && [...sb].every((ch) => FILLER.test(ch));
  if (cueLike && (!a || stripMarks(a).length > 8 || !hasFiller(a))) {
    return collapseRepeats(punctuateSpeech(b));
  }
  let picked = "";
  if (a && b) {
    if (hasFiller(b) && !hasFiller(a)) {
      const prefix = keepFillers(b);
      if (prefix && !stripMarks(a).includes(prefix)) {
        picked = collapseRepeats(`${prefix}${a}`);
      }
    }
    if (!picked) {
      const sa = stripMarks(a);
      picked = sa.length >= sb.length ? a : b;
    }
  } else {
    picked = a || b;
  }
  const out = collapseRepeats(punctuateSpeech(picked));
  if (shouldKeepOnlyCues(out) && salvageCues(out)) return punctuateSpeech(salvageCues(out));
  if (stripMarks(out)) return out;
  const salvaged = salvageCues(mixed);
  return salvaged ? punctuateSpeech(salvaged) : "";
}

export function recoverCues(stt: string, frames?: ProsodyFrame[]): string {
  const existing = stripHehe(stt.trim());
  if (!frames?.length) return existing;
  const islands = voicedIslands(frames);
  const heard = listenVocal(frames);
  const fixed = rewriteMisheardCues(existing, frames);

  if (fixed) return fixed;

  if (heard.kind === "laugh") return heard.text;
  if (heard.kind === "cry") return heard.text;
  if (heard.kind === "pant") return heard.text;
  if (heard.kind === "hum") return heard.text;

  const voiced = islands.filter(islandVoiced);
  if (!voiced.length) return "";
  if (voiced.length === islands.length) return cuesFromProsody(frames);
  return "";
}

function stripHehe(text: string) {
  return text.replace(/呵+/g, "").replace(/\s+/g, " ").trim();
}

const NG_MISHEAR = /^(算了|算啦|算咯|那|呐|嗯那|恩了|嗯了|嗯呐)$/;

function looksLikeClosedCue(frames: ProsodyFrame[]) {
  const heard = listenVocal(frames);
  if (heard.kind === "hum") return true;
  const islands = voicedIslands(frames);
  if (!islands.length) return false;
  const span = (islands[islands.length - 1]?.end ?? 0) - (islands[0]?.start ?? 0);
  if (span > 1.6) return false;
  return islands.every((island) => {
    const cue = classifyCue(island.frames);
    return cue === "嗯" || cue === "哼";
  });
}

function rewriteMisheardCues(text: string, frames?: ProsodyFrame[]) {
  const core = stripMarks(text);
  if (!NG_MISHEAR.test(core)) return text;
  if (!frames?.length || !looksLikeClosedCue(frames)) return text;
  const islands = voicedIslands(frames);
  if (!islands.length) return "嗯";
  return "嗯".repeat(Math.min(3, Math.max(1, islands.length)));
}

export function refineCueWords(
  text: string,
  _frames?: ProsodyFrame[],
  _words?: CueWord[],
): string {
  return text;
}

export function finishHeard(
  server: string,
  browser: string,
  _words: CueWord[] | undefined,
  frames: ProsodyFrame[] | undefined,
): string {
  const picked = pickTranscript(stripHehe(server), stripHehe(browser));
  return recoverCues(picked, frames);
}

function shapeSajiaoTail(text: string, frames?: ProsodyFrame[]): string {
  if (!text || !frames?.length || isMostlyFiller(text)) return text;
  const islands = voicedIslands(frames);
  const last = islands[islands.length - 1];
  if (!last || markForFrames(last.frames) !== "～") return text;
  const stripped = text.replace(/[。！？]?$/, "");
  if (!/[嘛啦呢呀哦噢嗯啊吧]$/.test(stripped)) return text;
  return `${stripped}～`;
}

export function shapeCueProsody(
  text: string,
  words: CueWord[] | undefined,
  frames: ProsodyFrame[] | undefined,
): string {
  if (!text || !frames?.length) return text;
  if (!isMostlyFiller(text) && !shouldKeepOnlyCues(text)) return text;
  const chars = [...stripMarks(text)].filter((ch) => FILLER.test(ch));
  if (!chars.length) return text;
  const islands = voicedIslands(frames);
  if (!islands.length) return text;

  const timed = (words ?? [])
    .map((word) => ({
      text: (word.text ?? "").trim(),
      start: Number(word.start),
      end: Number(word.end),
    }))
    .filter((word) => word.text && Number.isFinite(word.start) && Number.isFinite(word.end));

  const chunks: string[] = [];
  if (timed.length && timed.every((word) => isCueToken(word.text))) {
    for (const word of timed) {
      const slice = frames.filter((f) => f.t >= word.start - 0.04 && f.t <= word.end + 0.04);
      chunks.push(`${stripMarks(word.text)}${markForFrames(slice)}`);
    }
  } else {
    const total = islands.reduce((sum, island) => sum + Math.max(0.08, island.end - island.start), 0);
    let used = 0;
    for (let i = 0; i < islands.length; i += 1) {
      const island = islands[i]!;
      const share = Math.max(0.08, island.end - island.start) / total;
      let take = i === islands.length - 1 ? chars.length - used : Math.max(1, Math.round(chars.length * share));
      if (used + take > chars.length) take = chars.length - used;
      if (take <= 0) continue;
      const piece = chars.slice(used, used + take).join("");
      used += take;
      chunks.push(`${piece}${markForFrames(island.frames)}`);
    }
    if (used < chars.length && chunks.length) {
      chunks[chunks.length - 1] = `${chars.join("")}${markForFrames(islands[islands.length - 1]!.frames)}`;
    }
    const joined = glueCueParts(chunks, islands);
    return keepCuePunct(joined) || text;
  }

  const joined = chunks.join("").replace(/([…～！]){2,}/g, "$1");
  return keepCuePunct(joined) || text;
}
