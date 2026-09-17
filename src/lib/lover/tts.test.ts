import assert from "node:assert/strict";
import { test } from "node:test";
import { nextVoiceRate, snapVoiceRate, ttsSpeed } from "./tts.ts";

test("voice speed cycles through four natural Eve rates", () => {
  assert.equal(snapVoiceRate(1).label, "1.0");
  assert.equal(nextVoiceRate(1).label, "0.92");
  assert.equal(nextVoiceRate(0.92).label, "0.85");
  assert.equal(nextVoiceRate(0.85).label, "1.12");
  assert.equal(nextVoiceRate(1.12).label, "1.0");
  assert.equal(ttsSpeed(0.7), 0.85);
  assert.equal(ttsSpeed(0.9), 0.92);
});
