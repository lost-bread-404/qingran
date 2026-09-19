import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProsodyFrame } from "../prosody.ts";
import {
  applyUtteranceTag,
  formatAcousticTag,
  goldTagsFromTouched,
  parseAcousticTags,
  parsePartialAcousticTags,
  parseTagKeys,
  predictUtteranceTags,
  scoreTagAccuracy,
  tagsFromCues,
  tagsFromProsody,
  tagsTouched,
  toggleEventChip,
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

const base: AcousticTags = { length: "long", contour: "rising", voice: "breathy", events: [] };

test("utterance tag format joins events with + and leaves the slot empty", () => {
  assert.equal(formatAcousticTag(base), "〔long·rising·breathy｜〕");
  assert.equal(applyUtteranceTag("嗯今天好累", base), "嗯今天好累〔long·rising·breathy｜〕");
  assert.equal(formatAcousticTag({ ...base, events: ["laugh"] }), "〔long·rising·breathy｜laugh〕");
  assert.equal(
    formatAcousticTag({ ...base, contour: "wavering", events: ["cry", "moan"] }),
    "〔long·wavering·breathy｜cry+moan〕",
  );
});

test("old event field converts to events array on read, without rewriting none", () => {
  assert.deepEqual(parseAcousticTags({ length: "short", contour: "flat", voice: "normal", event: "none" }), {
    length: "short",
    contour: "flat",
    voice: "normal",
    events: [],
  });
  assert.deepEqual(parseAcousticTags({ length: "short", contour: "flat", voice: "normal", event: "laugh" }), {
    length: "short",
    contour: "flat",
    voice: "normal",
    events: ["laugh"],
  });
  assert.deepEqual(
    parseAcousticTags({ length: "long", contour: "wavering", voice: "breathy", events: ["cry", "moan"] }),
    { length: "long", contour: "wavering", voice: "breathy", events: ["cry", "moan"] },
  );
  assert.deepEqual(parsePartialAcousticTags({ event: "sigh" }), { events: ["sigh"] });
  assert.deepEqual(parsePartialAcousticTags({ events: [] }), { events: [] });
  assert.deepEqual(parseTagKeys(["length", "event", "voice"]), ["length", "events", "voice"]);
});

test("无 clears other events; picking an event cancels 无", () => {
  assert.deepEqual(toggleEventChip(["laugh", "cry"], "none"), []);
  assert.deepEqual(toggleEventChip([], "laugh"), ["laugh"]);
  assert.deepEqual(toggleEventChip(["laugh"], "cry"), ["laugh", "cry"]);
  assert.deepEqual(toggleEventChip(["laugh", "cry"], "laugh"), ["cry"]);
});

test("whisper and breath cues collapse into breathy / moan; cues merge events", () => {
  const tags = tagsFromCues([
    { length: "short", contour: "flat", voice: "whisper", event: "breath" },
    { length: "long", contour: "rising", voice: "normal", event: "cry" },
  ]);
  assert.equal(tags.length, "long");
  assert.equal(tags.voice, "breathy");
  assert.deepEqual(tags.events, ["cry", "moan"]);
  assert.equal(tags.contour, "rising");
});

test("tagsTouched only lists dimensions the user changed, including events", () => {
  const predicted: AcousticTags = { length: "short", contour: "flat", voice: "normal", events: [] };
  const chosen: AcousticTags = { length: "short", contour: "rising", voice: "breathy", events: [] };
  assert.deepEqual(tagsTouched(predicted, chosen), ["contour", "voice"]);
  assert.deepEqual(goldTagsFromTouched(chosen, ["contour", "voice"]), {
    contour: "rising",
    voice: "breathy",
  });
  const withEvents: AcousticTags = { ...predicted, events: ["laugh", "moan"] };
  assert.deepEqual(tagsTouched(predicted, withEvents), ["events"]);
  assert.deepEqual(goldTagsFromTouched(withEvents, ["events"]), { events: ["laugh", "moan"] });
});

test("tag accuracy keeps scalar dims; events use per-label precision and recall", () => {
  const predicted: AcousticTags = { length: "short", contour: "flat", voice: "normal", events: [] };
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
  assert.equal(scored.events.laugh.precision, null);
  assert.equal(scored.events.laugh.recall, null);

  const events = scoreTagAccuracy([
    {
      predictedTags: { ...predicted, events: ["laugh", "cry"] },
      goldTags: { events: ["laugh"] },
      tagsTouched: ["events"],
    },
    {
      predictedTags: { ...predicted, events: ["laugh"] },
      goldTags: { events: ["laugh", "moan"] },
      tagsTouched: ["events"],
    },
    {
      predictedTags: predicted,
      goldTags: { events: ["cry"] },
      tagsTouched: ["contour"],
    },
  ]);
  assert.equal(events.events.laugh.precision, 1);
  assert.equal(events.events.laugh.recall, 1);
  assert.equal(events.events.cry.precision, 0);
  assert.equal(events.events.cry.recall, null);
  assert.equal(events.events.moan.precision, null);
  assert.equal(events.events.moan.recall, 0);
  assert.equal(events.events.sigh.precision, null);
  assert.equal(events.events.sigh.recall, null);
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
  assert.deepEqual(fromCues.events, ["laugh"]);
  const fromFrames = predictUtteranceTags({
    frames: frames([
      { t: 0, rms: 0.04, hz: 180, clarity: 0.85 },
      { t: 0.12, rms: 0.04, hz: 182, clarity: 0.85 },
      { t: 0.2, rms: 0.035, hz: 178, clarity: 0.84 },
    ]),
  });
  assert.equal(fromFrames.length, "short");
});
