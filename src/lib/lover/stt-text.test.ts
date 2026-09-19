import assert from "node:assert/strict";
import { test } from "node:test";
import {
  browserSttReady,
  extractKeyterms,
  finishHeard,
  isHallucinationSuspect,
  needsPunctuationHelp,
  pickTranscript,
  punctuateSpeech,
  recoverCues,
  refineCueWords,
  restoreSpeechText,
  shapeCueProsody,
  scrubHallucination,
  sttKeyterms,
  STT_KEYTERMS,
  stripMarks,
} from "./stt-text.ts";
import { classifyCue, cuesFromProsody, voicedIslands, type ProsodyFrame } from "./prosody.ts";

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

test("extractKeyterms picks names from the prompt without dumping an ABO lexicon", () => {
  const prompt = `清然叫 Rosie 小猫。林泽住在隔壁。这是 ABO 世界观，omega 会释放信息素。`;
  const terms = extractKeyterms(prompt);
  assert.ok(terms.includes("Rosie"));
  assert.equal(terms.includes("信息素"), false);
  assert.equal(terms.includes("腺体"), false);
  assert.equal(terms.includes("发情期"), false);
  assert.equal(terms.includes("结合热"), false);
});

test("sttKeyterms ignores prompt extraction and only uses the fixed list", () => {
  const prompt = `清然叫 Rosie 小猫。林泽是一个中国的演员。这是 ABO 世界观，omega 会释放信息素。`;
  const terms = sttKeyterms(prompt);
  assert.deepEqual(terms, [...STT_KEYTERMS]);
  assert.equal(terms.includes("信息素"), false);
  assert.equal(terms.includes("林泽"), false);
  assert.equal(terms.includes("嗯嗯嗯"), false);
  assert.ok(terms.includes("姐姐"));
  assert.ok(terms.includes("清然"));
  assert.ok(terms.includes("小猫"));
  assert.ok(terms.includes("Rosie"));
  assert.ok(terms.includes("嗯"));
});

test("short quiet clip with a long xAI sentence is hallucination_suspect", () => {
  const xai = "林泽是一个中国的演员";
  assert.equal(isHallucinationSuspect({ durationSec: 0.6, peakRms: 0.002, xaiText: xai }), true);
  assert.equal(isHallucinationSuspect({ durationSec: 2.0, peakRms: 0.08, xaiText: xai }), false);
  assert.equal(isHallucinationSuspect({ durationSec: 0.4, peakRms: 0.002, xaiText: "嗯" }), false);
  const scrubbed = scrubHallucination("我喜欢你林泽是一个中国的演员", { durationSec: 0.5, peakRms: 0.001 }, "嗯");
  assert.equal(scrubbed.suspect, true);
  assert.equal(scrubbed.text, "嗯");
  assert.equal(
    finishHeard("林泽是一个中国的演员", "", undefined, undefined, { durationSec: 0.4, peakRms: 0.001 }),
    "",
  );
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
  assert.equal(recoverCues("嗯", ah), "嗯");
  assert.equal(recoverCues("哼，我才不要", ah), "哼，我才不要");
  assert.equal(finishHeard("嗯", "", undefined, ah).includes("啊") && pickTranscript("嗯", "") === "嗯", false);
  assert.equal(stripMarks(finishHeard("嗯", "", undefined, ah)), "嗯");
});

test("empty STT recovers cute / cry / pant from audio", () => {
  const ah = Array.from({ length: 8 }, (_, i) =>
    frame({ t: i * 0.04, rms: 0.09, centroid: 1300, bright: 0.42, hz: 240 }),
  );
  assert.match(recoverCues("", ah), /啊/);
  assert.match(stripMarks(finishHeard("", "", undefined, ah)), /啊/);

  const cry = Array.from({ length: 14 }, (_, i) =>
    frame({
      t: i * 0.04,
      rms: 0.07 - i * 0.003,
      hz: 190,
      clarity: 0.88,
      centroid: 520,
      bright: 0.14,
    }),
  );
  assert.equal(classifyCue(cry), "呜");
  assert.match(cuesFromProsody(cry), /呜/);
  assert.match(recoverCues("", cry), /呜/);
  assert.match(stripMarks(finishHeard("", "", undefined, cry)), /呜/);

  const pant: ProsodyFrame[] = [];
  for (let burstN = 0; burstN < 3; burstN += 1) {
    const t0 = burstN * 0.45;
    for (let i = 0; i < 6; i += 1) {
      pant.push(
        frame({
          t: t0 + i * 0.04,
          rms: 0.04,
          hz: 0,
          clarity: 0.3,
          centroid: 1400,
          bright: 0.28,
        }),
      );
    }
    pant.push(frame({ t: t0 + 0.3, rms: 0.002, hz: 0, clarity: 0, centroid: 0, bright: 0 }));
  }
  assert.equal(classifyCue(pant.slice(0, 6)), "啊");
  assert.match(cuesFromProsody(pant), /啊/);
  assert.doesNotMatch(cuesFromProsody(pant), /哈/);
  assert.match(recoverCues("", pant), /啊/);
  assert.match(stripMarks(finishHeard("", "", undefined, pant)), /啊/);
  assert.match(stripMarks(finishHeard("哈哈哈哈", "", undefined, pant)), /哈/);
});

test("empty STT does not turn room noise into 喘息", () => {
  const rumble: ProsodyFrame[] = [];
  for (let i = 0; i < 48; i += 1) {
    const on = i % 8 < 3;
    rumble.push(
      frame({
        t: i * 0.04,
        rms: on ? 0.014 + (i % 3) * 0.003 : 0.002,
        hz: 0,
        clarity: 0.12,
        centroid: 380,
        bright: 0.07,
      }),
    );
  }
  assert.equal(recoverCues("", rumble), "");
  assert.equal(finishHeard("", "", undefined, rumble), "");
});

test("latin ASR guesses of vocalizations become 语气词", () => {
  assert.equal(stripMarks(restoreSpeechText("ahh")), "啊");
  assert.equal(stripMarks(restoreSpeechText("hmm")), "嗯");
  assert.equal(stripMarks(restoreSpeechText("woo")), "呜");
  assert.equal(stripMarks(restoreSpeechText("ha ha")), "哈哈");
  assert.equal(stripMarks(restoreSpeechText("抽泣")), "呜呜");
  assert.equal(stripMarks(restoreSpeechText("喘气")), "啊");
  assert.equal(stripMarks(restoreSpeechText("pant")), "啊");
  assert.equal(pickTranscript("sob", ""), "呜呜");
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

function hush(t: number): ProsodyFrame {
  return frame({ t, rms: 0.0015, hz: 0, clarity: 0, centroid: 0, bright: 0 });
}

function burst(t0: number, n: number, shape: Partial<ProsodyFrame> = {}): ProsodyFrame[] {
  const out: ProsodyFrame[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(
      frame({
        rms: 0.05,
        hz: 200,
        clarity: 0.9,
        centroid: 900,
        bright: 0.3,
        ...shape,
        t: t0 + i * 0.04,
      }),
    );
  }
  return out;
}

test("STT phones are kept; laugh and cry come from the sound itself", () => {
  const ahGlide = burst(0, 8, { centroid: 1200, bright: 0.42, hz: 180 });
  ahGlide.forEach((f, i) => {
    f.hz = 170 + i * 14;
    f.rms = 0.055;
  });
  const ahFade = burst(0.55, 8, { centroid: 1100, bright: 0.38, hz: 220 });
  ahFade.forEach((f, i) => {
    f.rms = 0.07 - i * 0.006;
  });
  const sob = burst(1.15, 10, { centroid: 500, bright: 0.12, hz: 190, clarity: 0.88 });
  sob.forEach((f, i) => {
    f.rms = 0.07 - i * 0.004;
  });
  const hit = burst(1.75, 4, { centroid: 1300, bright: 0.45, hz: 240, rms: 0.12 });
  const ng1 = burst(2.15, 7, { centroid: 480, bright: 0.1, hz: 160, clarity: 0.9, rms: 0.035 });
  ng1.forEach((f, i) => {
    f.rms = 0.04 - i * 0.003;
  });
  const ng2 = burst(2.65, 7, { centroid: 500, bright: 0.11, hz: 155, clarity: 0.9, rms: 0.034 });
  ng2.forEach((f, i) => {
    f.rms = 0.038 - i * 0.003;
  });
  const ng3 = burst(3.15, 9, { centroid: 520, bright: 0.12, hz: 150, clarity: 0.9 });
  ng3.forEach((f, i) => {
    f.hz = 150 + i * 8;
    f.rms = 0.04;
  });
  const frames = [
    ...ahGlide,
    hush(0.42),
    ...ahFade,
    hush(0.98),
    ...sob,
    hush(1.62),
    ...hit,
    hush(1.98),
    ...ng1,
    hush(2.5),
    ...ng2,
    hush(3.0),
    ...ng3,
  ];

  assert.ok(voicedIslands(frames).length >= 5, `islands=${voicedIslands(frames).length}`);

  const fromAh = finishHeard("啊", "", undefined, frames);
  assert.equal(stripMarks(fromAh), "啊");
  assert.doesNotMatch(fromAh, /哈/);

  const heard = finishHeard("啊啊呜呜嗯嗯", "", undefined, frames);
  assert.match(stripMarks(heard), /啊/);
  assert.match(stripMarks(heard), /呜/);
  assert.match(stripMarks(heard), /嗯/);
});

test("laughter is transcribed as 哈, not 啊", () => {
  const frames: ProsodyFrame[] = [];
  for (let p = 0; p < 6; p += 1) {
    const t0 = p * 0.24;
    for (let i = 0; i < 3; i += 1) {
      frames.push(
        frame({
          t: t0 + i * 0.04,
          rms: 0.06,
          hz: 0,
          clarity: 0.32,
          centroid: 1600,
          bright: 0.34,
        }),
      );
    }
    frames.push(hush(t0 + 0.16));
  }
  const heard = finishHeard("", "", undefined, frames);
  assert.match(heard, /哈/);
  assert.doesNotMatch(heard, /啊|嗯|呜/);
});

test("real words are not replaced by a moan track", () => {
  const ah = burst(0, 8, { centroid: 1300, bright: 0.42, hz: 240 });
  assert.equal(stripMarks(finishHeard("嗯，我想你了", "", undefined, ah)), "嗯我想你了");
});

test("呵呵 is dropped from cues", () => {
  assert.equal(stripMarks(restoreSpeechText("呵呵")), "");
  assert.doesNotMatch(finishHeard("呵呵", "", undefined, undefined), /呵/);
});

test("算了 hummed as 嗯 is not kept as 算了", () => {
  const hum: ProsodyFrame[] = [];
  for (let p = 0; p < 2; p += 1) {
    const t0 = p * 0.45;
    for (let i = 0; i < 8; i += 1) {
      hum.push(
        frame({
          t: t0 + i * 0.04,
          rms: 0.035,
          hz: 170,
          clarity: 0.88,
          centroid: 520,
          bright: 0.12,
        }),
      );
    }
    hum.push(hush(t0 + 0.38));
  }
  const heard = finishHeard("算了", "", undefined, hum);
  assert.match(heard, /嗯/);
  assert.doesNotMatch(heard, /算了/);
});

test("short 嗯 is passed through without 语气 marks", () => {
  const ng = Array.from({ length: 10 }, (_, i) =>
    frame({
      t: i * 0.04,
      rms: 0.035,
      hz: 160 + i * 8,
      clarity: 0.9,
      centroid: 500,
      bright: 0.12,
    }),
  );
  assert.equal(finishHeard("嗯", "", undefined, ng), "嗯");
  assert.equal(finishHeard("嗯嗯", "", undefined, ng), "嗯嗯");
});

test("STT 嗯嗯嗯 is not rewritten with commas", () => {
  const frames: ProsodyFrame[] = [];
  for (let p = 0; p < 3; p += 1) {
    const t0 = p * 0.5;
    for (let i = 0; i < 8; i += 1) {
      frames.push(
        frame({
          t: t0 + i * 0.04,
          rms: 0.035,
          hz: 170,
          clarity: 0.9,
          centroid: 500,
          bright: 0.12,
        }),
      );
    }
    frames.push(hush(t0 + 0.4));
  }
  assert.equal(finishHeard("嗯嗯嗯", "", undefined, frames), "嗯嗯嗯");
});

test("browser STT with real words can skip the server", () => {
  assert.equal(browserSttReady("我想你了"), true);
  assert.equal(browserSttReady("嗯，我想你了"), true);
  assert.equal(browserSttReady("嗯"), false);
  assert.equal(browserSttReady("嗯嗯～"), false);
  assert.equal(browserSttReady(""), false);
});


