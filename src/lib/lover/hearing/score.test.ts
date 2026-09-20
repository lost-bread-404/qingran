import assert from "node:assert/strict";
import { test } from "node:test";
import { cer, textsExact } from "./metrics.ts";
import { scoreHearing, type ScoreClip } from "./score.ts";
import { hashSplit } from "./split.ts";

function clip(partial: Partial<ScoreClip> & Pick<ScoreClip, "id">): ScoreClip {
  return {
    createdAt: "2026-09-18T00:00:00.000Z",
    finalText: "",
    xaiText: "",
    liveText: "",
    goldText: "",
    noiseOnly: false,
    utteranceEmotion: null,
    turnId: partial.id,
    ...partial,
  };
}

test("score card CER, exact match, noise rate, and worst-20 order", () => {
  const now = Date.parse("2026-09-19T00:00:00.000Z");
  const scored = scoreHearing(
    [
      clip({ id: "a", goldText: "在吗", finalText: "在吗", xaiText: "在吗", liveText: "在吗", utteranceEmotion: "neutral" }),
      clip({ id: "b", goldText: "嗯", finalText: "我喜欢你", xaiText: "我喜欢你", liveText: "", utteranceEmotion: "coy" }),
      clip({ id: "c", goldText: "", finalText: "噪音", xaiText: "噪音", noiseOnly: true }),
      clip({ id: "d", goldText: "啊", finalText: "", xaiText: "", liveText: "", noiseOnly: true }),
      clip({
        id: "old",
        createdAt: "2026-01-01T00:00:00.000Z",
        goldText: "旧",
        finalText: "错很多字啊",
      }),
    ],
    { window: "7d", hallucinationN: 2, hallucinationByReason: { apple_empty: 1, short_quiet: 1 }, now },
  );
  assert.equal(scored.clipN, 4);
  assert.equal(scored.goldN, 3);
  assert.equal(scored.cerFinal, scored.worst[0] ? (0 + scored.worst[0].cer + scored.worst[1]!.cer) / 3 : null);
  assert.equal(scored.exactMatch, 1 / 3);
  assert.ok(scored.toneAccuracy != null);
  assert.equal(scored.liveHasData, true);
  assert.equal(scored.liveEmptyRate, 2 / 3);
  assert.equal(scored.noiseN, 2);
  assert.equal(scored.noiseRecognizedRate, 0.5);
  assert.equal(scored.hallucinationN, 2);
  assert.equal(scored.hallucinationByReason.apple_empty, 1);
  assert.equal(scored.hallucinationByReason.short_quiet, 1);
  assert.equal(scored.engineUse.n, 0);
  assert.equal(scored.worst[0]?.id, "b");
  assert.equal(scored.worst[0]?.hyp, "我喜欢你");
  assert.equal(scored.worst[0]?.gold, "嗯");
  assert.ok((scored.cerXai ?? 1) > 0);
  assert.equal(scored.cerLive !== null, true);
});

test("Apple live_text all empty is 无数据 with empty rate 1", () => {
  const scored = scoreHearing([
    clip({ id: "e", goldText: "嗯", finalText: "嗯", liveText: "" }),
    clip({ id: "f", goldText: "啊", finalText: "啊", liveText: "   " }),
  ]);
  assert.equal(scored.liveHasData, false);
  assert.equal(scored.cerLive, null);
  assert.equal(scored.liveEmptyRate, 1);
  assert.equal(scored.exactMatch, 1);
  assert.equal(scored.cerFinal, 0);
});

test("exactMatch ignores punctuation the same way CER does", () => {
  assert.equal(textsExact("姐姐。", "姐姐"), true);
  assert.equal(cer("姐姐。", "姐姐"), 0);
  const scored = scoreHearing([clip({ id: "p", goldText: "姐姐。", finalText: "姐姐" })]);
  assert.equal(scored.exactMatch, 1);
  assert.equal(scored.cerFinal, 0);
});

test("acoustic tag accuracy only uses tags_touched dimensions", () => {
  const scored = scoreHearing([
    clip({
      id: "a",
      goldText: "嗯",
      finalText: "嗯",
      predictedTags: { length: "short", contour: "flat", voice: "normal", events: [] },
      goldTags: { contour: "rising" },
      tagsTouched: ["contour"],
    }),
    clip({
      id: "b",
      goldText: "啊",
      finalText: "啊",
      predictedTags: { length: "short", contour: "flat", voice: "normal", events: [] },
      goldTags: { length: "short" },
      tagsTouched: ["length"],
    }),
  ]);
  assert.equal(scored.tagAccuracy.contour, 0);
  assert.equal(scored.tagAccuracy.length, 1);
  assert.equal(scored.tagAccuracy.voice, null);
});

test("unlabeled clips drop out of the score card; re-edit updates exactMatch", () => {
  const labeled = scoreHearing([
    clip({ id: "a", goldText: "在吗", finalText: "在吗呀" }),
    clip({ id: "b", goldText: "嗯", finalText: "嗯" }),
  ]);
  assert.equal(labeled.goldN, 2);
  assert.equal(labeled.exactMatch, 0.5);
  assert.ok((labeled.cerFinal ?? 0) > 0);

  const unlabeled = scoreHearing([
    clip({ id: "a", goldText: "", finalText: "在吗呀" }),
    clip({ id: "b", goldText: "嗯", finalText: "嗯" }),
  ]);
  assert.equal(unlabeled.clipN, 2);
  assert.equal(unlabeled.goldN, 1);
  assert.equal(unlabeled.exactMatch, 1);
  assert.equal(unlabeled.cerFinal, 0);
  assert.equal(unlabeled.worst[0]?.id, "b");

  const reedited = scoreHearing([
    clip({ id: "a", goldText: "在吗呀", finalText: "在吗呀" }),
    clip({ id: "b", goldText: "嗯", finalText: "嗯" }),
  ]);
  assert.equal(reedited.goldN, 2);
  assert.equal(reedited.exactMatch, 1);
  assert.equal(reedited.cerFinal, 0);
});

test("labeled empty gold vs nonempty hyp is CER 1", () => {
  assert.equal(cer("", "谢谢观看"), 1);
  assert.equal(cer("", ""), 0);
  const scored = scoreHearing([
    clip({ id: "a", goldText: "", goldSource: "edited", finalText: "谢谢观看" }),
    clip({ id: "b", goldText: "嗯", goldSource: "confirmed", finalText: "嗯" }),
  ]);
  assert.equal(scored.goldN, 2);
  assert.equal(scored.cerFinal, 0.5);
  assert.equal(scored.worst[0]?.id, "a");
  assert.equal(scored.worst[0]?.cer, 1);
  assert.equal(scored.exactMatch, 0.5);
});

test("id hash split is stable and roughly 80/20", () => {
  assert.equal(hashSplit("clip-1"), hashSplit("clip-1"));
  const ids = Array.from({ length: 200 }, (_, i) => `id-${i}`);
  const testN = ids.filter((id) => hashSplit(id) === "test").length;
  assert.ok(testN >= 20 && testN <= 60, `got ${testN} test ids`);
});

test("toneAccuracy compares punctuation marks not characters", () => {
  const scored = scoreHearing([
    clip({ id: "a", goldText: "嗯～", finalText: "嗯～" }),
    clip({ id: "b", goldText: "在吗？", finalText: "在吗。" }),
    clip({ id: "c", goldText: "啊…", finalText: "啊～" }),
  ]);
  assert.equal(scored.toneAccuracy, 1 / 3);
});
