import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractKeyterms,
  finishHeard,
  needsPunctuationHelp,
  pickTranscript,
  punctuateSpeech,
  recoverCues,
  refineCueWords,
  restoreSpeechText,
  shapeCueProsody,
  stripMarks,
} from "./stt-text.ts";
import type { ProsodyFrame } from "./prosody.ts";

function frame(partial: Partial<ProsodyFrame> & Pick<ProsodyFrame, "t" | "rms">): ProsodyFrame {
  return {
    hz: 180,
    clarity: 0.9,
    centroid: 800,
    bright: 0.25,
    ...partial,
  };
}

test("punctuateSpeech adds a period to a long bare sentence", () => {
  const text = punctuateSpeech("今天天气很好我想出去走走");
  assert.match(text, /。$/);
});

test("pickTranscript punctuates browser fallback text", () => {
  const heard = pickTranscript("", "我想你了今天过得怎么样");
  assert.match(heard, /[。？！]$/);
});

test("restoreSpeechText keeps going when word timestamps overlap", () => {
  const raw = "我想你了今天过得怎么样晚上想吃面";
  const words = [
    { text: "我", start: 0, end: 0.2 },
    { text: "想", start: 0.2, end: 0.4 },
    { text: "你", start: 0.35, end: 0.5 },
    { text: "了", start: 0.5, end: 0.7 },
    { text: "今天", start: 1.1, end: 1.4 },
    { text: "过得", start: 1.4, end: 1.7 },
    { text: "怎么样", start: 1.7, end: 2.1 },
    { text: "晚上", start: 2.8, end: 3.1 },
    { text: "想", start: 3.1, end: 3.3 },
    { text: "吃面", start: 3.3, end: 3.7 },
  ];
  const text = restoreSpeechText(raw, words);
  assert.ok(stripMarks(text).includes("吃面"));
});

test("short hesitations do not become commas", () => {
  const words = [
    { text: "我", start: 0, end: 0.18 },
    { text: "今天", start: 0.32, end: 0.55 },
    { text: "有点", start: 0.7, end: 0.9 },
    { text: "累", start: 1.05, end: 1.2 },
  ];
  const text = restoreSpeechText("我今天有点累", words);
  assert.equal((text.match(/，/g) ?? []).length, 0);
});

test("restoreSpeechText prefers the longer transcript", () => {
  const raw = "前半截后面还有很多话没有被切掉";
  const words = [
    { text: "前半截", start: 0, end: 0.4 },
    { text: "后面", start: 0.3, end: 0.6 },
  ];
  const text = restoreSpeechText(raw, words);
  assert.ok(stripMarks(text).includes("没有被切掉"));
});

test("needsPunctuationHelp catches long unpunctuated speech", () => {
  assert.equal(needsPunctuationHelp("短"), false);
  assert.equal(
    needsPunctuationHelp("我想跟你说今天下午发生了很多事然后晚上又去了超市买菜回来还做饭"),
    true,
  );
  assert.equal(needsPunctuationHelp("今天天气很好。我想出去走走。你呢？"), false);
});

test("extractKeyterms picks names and ABO words from the prompt", () => {
  const prompt = `清然叫 Rosie 小猫。林泽住在隔壁。这是 ABO 世界观，omega 会释放信息素。`;
  const terms = extractKeyterms(prompt);
  assert.ok(terms.includes("Rosie"));
  assert.ok(terms.includes("信息素"));
  assert.ok(terms.includes("Omega") || terms.includes("omega"));
});

test("cue punctuation stays as heard", () => {
  assert.equal(punctuateSpeech("想你了嘛"), "想你了嘛。");
  assert.equal(punctuateSpeech("嗯啊～"), "嗯啊～");
  assert.equal(punctuateSpeech("啊啊…"), "啊啊…");
  assert.equal(punctuateSpeech("嗯"), "嗯");
});

test("short cues stay sendable", () => {
  assert.equal(punctuateSpeech("嗯"), "嗯");
  assert.equal(punctuateSpeech("喵"), "喵");
  assert.equal(punctuateSpeech("啊"), "啊");
  assert.equal(punctuateSpeech("嗷呜"), "嗷呜");
  assert.equal(punctuateSpeech("哼"), "哼");
  assert.equal(punctuateSpeech("呜呜"), "呜呜");
  assert.equal(pickTranscript("嗯", ""), "嗯");
  assert.equal(pickTranscript("", "喵"), "喵");
  assert.equal(restoreSpeechText("恩"), "嗯");
  assert.equal(pickTranscript("今天天气很好", "喵"), "喵");
});

test("stacked cues are kept", () => {
  assert.equal(punctuateSpeech("啊啊啊呜呜呜嗯嗯嗯"), "啊啊啊呜呜呜嗯嗯嗯");
  assert.equal(punctuateSpeech("嗷呜嗷呜嗷呜"), "嗷呜嗷呜嗷呜");
  assert.equal(pickTranscript("", "嗷呜嗷呜嗷呜"), "嗷呜嗷呜嗷呜");
  assert.equal(pickTranscript("", "啊啊…"), "啊啊…");
});

test("crying keeps audible cues instead of dropping the turn", () => {
  assert.equal(pickTranscript("", "（抽泣）啊……呜"), "啊呜");
  assert.equal(pickTranscript(" ", "咳啊呜咳"), "啊呜");
});

test("shapeCueProsody marks long fade, pitch glide, and stress", () => {
  const fade = Array.from({ length: 12 }, (_, i) =>
    frame({ t: i * 0.05, rms: 0.08 - i * 0.005, hz: 180, centroid: 500, bright: 0.12 }),
  );
  const quiet = [frame({ t: 0.7, rms: 0.002, hz: 0 }), frame({ t: 0.85, rms: 0.002, hz: 0 })];
  const glide = Array.from({ length: 10 }, (_, i) =>
    frame({ t: 0.95 + i * 0.04, rms: 0.05, hz: 160 + i * 12, centroid: 1100, bright: 0.4 }),
  );
  const gap = [frame({ t: 1.5, rms: 0.002, hz: 0 })];
  const hit = Array.from({ length: 4 }, (_, i) =>
    frame({ t: 1.6 + i * 0.04, rms: 0.12, hz: 200, centroid: 1200, bright: 0.45 }),
  );
  const hush = [frame({ t: 1.82, rms: 0.002, hz: 0 })];
  const rest = Array.from({ length: 8 }, (_, i) =>
    frame({ t: 1.95 + i * 0.04, rms: 0.04, hz: 190, centroid: 1000, bright: 0.35 }),
  );
  const text = shapeCueProsody("嗯嗯啊啊啊啊", undefined, [
    ...fade,
    ...quiet,
    ...glide,
    ...gap,
    ...hit,
    ...hush,
    ...rest,
  ]);
  assert.match(text, /…/);
  assert.match(text, /～/);
  assert.match(text, /！/);
});

test("recoverCues does not invent 啊 or 嗷 over STT", () => {
  const ah = Array.from({ length: 8 }, (_, i) =>
    frame({ t: i * 0.04, rms: 0.09, centroid: 1300, bright: 0.42, hz: 240 }),
  );
  assert.equal(recoverCues("", ah), "");
  assert.equal(recoverCues("嗯", ah), "嗯");
  assert.equal(recoverCues("哼，我才不要", ah), "哼，我才不要");
  assert.equal(finishHeard("嗯", "", undefined, ah).includes("啊") && pickTranscript("嗯", "") === "嗯", false);
  assert.equal(stripMarks(finishHeard("嗯", "", undefined, ah)), "嗯");
});

test("leading 哼 is left to STT, not rewritten by pitch", () => {
  const heng = Array.from({ length: 6 }, (_, i) =>
    frame({ t: i * 0.03, rms: 0.035, centroid: 780, bright: 0.2, hz: 210, clarity: 0.7 }),
  );
  const hush = [frame({ t: 0.28, rms: 0.002, hz: 0, centroid: 0, bright: 0, clarity: 0 })];
  const speech = Array.from({ length: 20 }, (_, i) =>
    frame({ t: 0.45 + i * 0.04, rms: 0.06, centroid: 1400, bright: 0.4, hz: 200, clarity: 0.9 }),
  );
  const frames = [...heng, ...hush, ...speech];
  assert.equal(refineCueWords("嗯，我才不要", frames), "嗯，我才不要");
  assert.equal(refineCueWords("哼，我才不要", frames), "哼，我才不要");
});


