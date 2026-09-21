import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyAudioRoute } from "./route.ts";

test("classifies headphones vs speaker vs unknown", () => {
  assert.equal(classifyAudioRoute("AirPods Pro"), "headphones");
  assert.equal(classifyAudioRoute("蓝牙耳机"), "headphones");
  assert.equal(classifyAudioRoute("MacBook Speakers"), "speaker");
  assert.equal(classifyAudioRoute("扬声器"), "speaker");
  assert.equal(classifyAudioRoute(""), "unknown");
  assert.equal(classifyAudioRoute("default"), "unknown");
});
