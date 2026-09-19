import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProsodyFrame } from "../prosody.ts";
import {
  applyUtteranceTag,
  formatAcousticTag,
  goldTagsFromTouched,
  predictUtteranceTags,
  scoreTagAccuracy,
  tagsFromCues,
  tagsFromProsody,
  tagsTouched,
  type AcousticTags,
} from "./tags.ts";

function frames(partial: Array<Partial<ProsodyFrame> & { t: number }>): ProsodyFrame[] {
  return partial.map((row) => ({
    t: row.t,
    rms: row.rms ?? 0.04,
    hz: row.hz ?? 180,
    clarity: row.clarity ?? 0.8,
    centroid: row.centroid ?? 600,
    bright: row.bright ?? 0.2,
  }));
}

test("utterance tag format is 长短·走向·声线 with empty emotion slot", () => {
  const tags: AcousticTags = { length: "long", contour: "rising", voice: "breathy", event: "none" };
  assert.equal(formatAcousticTag(tags), "〔long·rising·breathy｜〕");
  assert.equal(applyUtteranceTag("嗯今天好累", tags), "嗯今天好累〔long·rising·breathy｜〕");
  assert.equal(
    formatAcousticTag({ ...tags, event: "laugh" }),
    "〔long·rising·breathy｜laugh〕",
  );
});

test("whisper and breath cues collapse into breathy / sigh", () => {
  const tags = tagsFromCues([
    { length: "short", contour: "flat", voice: "whisper", event: "breath" },
    { length: "long", contour: "rising", voice: "normal" },
  ]);
  assert.equal(tags.length, "long");
  assert.equal(tags.voice, "breathy");
  assert.equal(tags.event, "sigh");
  assert.equal(tags.contour, "rising");
});

test("tagsTouched only lists dimensions the user changed", () => {
  const predicted: AcousticTags = { length: "short", contour: "flat", voice: "normal", event: "none" };
  const chosen: AcousticTags = { length: "short", contour: "rising", voice: "breathy", event: "none" };
  assert.deepEqual(tagsTouched(predicted, chosen), ["contour", "voice"]);
  assert.deepEqual(goldTagsFromTouched(chosen, ["contour", "voice"]), {
    contour: "rising",
    voice: "breathy",
  });
});

test("tag accuracy only scores tags_touched dimensions", () => {
  const predicted: AcousticTags = { length: "short", contour: "flat", voice: "normal", event: "none" };
  const scored = scoreTagAccuracy([
    {
      predictedTags: predicted,
      goldTags: { contour: "rising" },
      tagsTouched: ["contour"],
    },
    {
      predictedTags: predicted,
      goldTags: { length: "short", contour: "flat" },
      tagsTouched: ["length"],
    },
    {
      predictedTags: predicted,
      goldTags: { voice: "breathy" },
      tagsTouched: [],
    },
  ]);
  assert.equal(scored.contour, 0);
  assert.equal(scored.length, 1);
  assert.equal(scored.voice, null);
  assert.equal(scored.event, null);
});

test("prosody maps duration, pitch glide, and laugh bursts", () => {
  const shortFlat = tagsFromProsody(
    frames([
      { t: 0, rms: 0.04, hz: 180, clarity: 0.85 },
      { t: 0.12, rms: 0.04, hz: 182, clarity: 0.85 },
      { t: 0.2, rms: 0.035, hz: 178, clarity: 0.84 },
    ]),
  );
  assert.equal(shortFlat.length, "short");

  const rising = tagsFromProsody(
    frames(Array.from({ length: 12 }, (_, i) => ({
      t: i * 0.05,
      rms: 0.05,
      hz: 140 + i * 12,
      clarity: 0.85,
    }))),
  );
  assert.equal(rising.length, "long");
  assert.equal(rising.contour, "rising");
});

test("predictUtteranceTags prefers cues over frames", () => {
  const fromCues = predictUtteranceTags({
    cues: [{ length: "long", contour: "rising", voice: "whisper", event: "laugh" }],
    frames: frames([{ t: 0, rms: 0.04, hz: 180 }, { t: 0.1, rms: 0.04, hz: 180 }]),
  });
  assert.equal(fromCues.length, "long");
  assert.equal(fromCues.voice, "breathy");
  assert.equal(fromCues.event, "laugh");
  const fromFrames = predictUtteranceTags({
    frames: frames([
      { t: 0, rms: 0.04, hz: 180, clarity: 0.85 },
      { t: 0.12, rms: 0.04, hz: 182, clarity: 0.85 },
      { t: 0.2, rms: 0.035, hz: 178, clarity: 0.84 },
    ]),
  });
  assert.equal(fromFrames.length, "short");
});
