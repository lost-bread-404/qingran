import assert from "node:assert/strict";
import { test } from "node:test";
import { VOICE_IO } from "./brain/config.ts";
import { shouldFlushSpoken, ttsRequestBody, ttsSpeed, TTS_SPEED_SOFT } from "./tts.ts";

test("first spoken flush waits for a sentence end", () => {
  assert.equal(shouldFlushSpoken("我想你了", true), false);
  assert.equal(shouldFlushSpoken("我想你了。", true), true);
  assert.equal(shouldFlushSpoken("今晚呢？", true), true);
});

test("later flushes stay on the same stream after a sentence", () => {
  assert.equal(shouldFlushSpoken("过来。", false), true);
  assert.equal(shouldFlushSpoken("还没有句号的半句", false), false);
});

test("soft voice uses Eve's slowest natural speed", () => {
  assert.equal(ttsSpeed(false), 1);
  assert.equal(ttsSpeed(true), TTS_SPEED_SOFT);
  assert.equal(TTS_SPEED_SOFT, 0.7);
});

test("tts request body reads VOICE_IO", () => {
  const body = ttsRequestBody("想你", "zh");
  assert.equal(body.voice_id, VOICE_IO.voice);
  assert.equal(body.output_format.codec, VOICE_IO.codec);
  assert.equal(body.output_format.sample_rate, VOICE_IO.sampleRate);
  assert.equal(body.language, "zh");
  assert.equal(body.speed, 1);
});
