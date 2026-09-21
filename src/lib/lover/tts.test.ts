import assert from "node:assert/strict";
import { test } from "node:test";
import { VOICE_IO } from "./brain/config.ts";
import {
  nextVoiceRate,
  shouldFlushSpoken,
  snapVoiceRate,
  ttsRequestBody,
  ttsSpeed,
  TTS_SPEED_SOFT,
} from "./tts.ts";

test("first spoken flush waits for a sentence end", () => {
  assert.equal(shouldFlushSpoken("我想你了", true), false);
  assert.equal(shouldFlushSpoken("我想你了。", true), true);
  assert.equal(shouldFlushSpoken("今晚呢？", true), true);
});

test("later flushes stay on the same stream after a sentence", () => {
  assert.equal(shouldFlushSpoken("过来。", false), true);
  assert.equal(shouldFlushSpoken("还没有句号的半句", false), false);
});

test("voice speed cycles through four natural Eve rates", () => {
  assert.equal(snapVoiceRate(1).label, "1.0");
  assert.equal(nextVoiceRate(1).label, "0.92");
  assert.equal(nextVoiceRate(0.92).label, "0.85");
  assert.equal(nextVoiceRate(0.85).label, "1.12");
  assert.equal(nextVoiceRate(1.12).label, "1.0");
  assert.equal(ttsSpeed(0.7), 0.85);
  assert.equal(ttsSpeed(0.9), 0.92);
  assert.equal(TTS_SPEED_SOFT, 0.92);
});

test("tts request body reads VOICE_IO", () => {
  const body = ttsRequestBody("想你", "zh");
  assert.equal(body.voice_id, VOICE_IO.voice);
  assert.equal(body.output_format.codec, VOICE_IO.codec);
  assert.equal(body.output_format.sample_rate, VOICE_IO.sampleRate);
  assert.equal(body.language, "zh");
  assert.equal(body.speed, 1);
});
