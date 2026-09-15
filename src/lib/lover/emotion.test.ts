import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProsodyFrame } from "./prosody.ts";
import { applyFeelToText, feelFromFrames } from "./emotion.ts";

function frame(partial: Partial<ProsodyFrame> & Pick<ProsodyFrame, "t" | "rms">): ProsodyFrame {
  return {
    hz: 180,
    clarity: 0.9,
    centroid: 800,
    bright: 0.25,
    ...partial,
  };
}

test("rising closed voice is 撒娇", () => {
  const frames = Array.from({ length: 12 }, (_, i) =>
    frame({
      t: i * 0.04,
      rms: 0.035,
      hz: 160 + i * 10,
      clarity: 0.9,
      centroid: 520,
      bright: 0.14,
    }),
  );
  assert.equal(feelFromFrames(frames), "sajiao");
  assert.equal(applyFeelToText("嗯", "sajiao"), "嗯～");
  assert.equal(applyFeelToText("想你了嘛。", "sajiao"), "想你了嘛～");
});

test("falling dark voice is sad", () => {
  const frames = Array.from({ length: 14 }, (_, i) =>
    frame({
      t: i * 0.04,
      rms: 0.07 - i * 0.004,
      hz: 200 - i * 6,
      clarity: 0.88,
      centroid: 500,
      bright: 0.12,
    }),
  );
  assert.equal(feelFromFrames(frames), "sad");
  assert.equal(applyFeelToText("呜呜", "sad"), "呜呜…");
});

test("feel does not decorate ordinary sentences", () => {
  assert.equal(applyFeelToText("今天天气很好。", "sajiao"), "今天天气很好。");
  assert.equal(applyFeelToText("我想你了。", "hot"), "我想你了。");
});
