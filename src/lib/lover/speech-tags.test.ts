import assert from "node:assert/strict";
import { test } from "node:test";
import { spokenForTts, stripSpeechTags } from "./speech-tags.ts";

test("stripSpeechTags keeps paragraph breaks", () => {
  const raw = "她把杯子放下。\n\n<soft>过来。</soft>";
  assert.equal(stripSpeechTags(raw), "她把杯子放下。\n\n过来。");
});

test("stripSpeechTags turns pause tags into line breaks", () => {
  assert.equal(stripSpeechTags("过来。[pause]我在。"), "过来。\n我在。");
});

test("spokenForTts uses pause instead of extra periods for newlines", () => {
  const spoken = spokenForTts("她把杯子放下。\n\n过来。");
  assert.match(spoken, /\[pause\]/);
  assert.doesNotMatch(spoken, /。。/);
});

test("spokenForTts keeps speech tags", () => {
  const spoken = spokenForTts("<soft>过来。</soft>");
  assert.match(spoken, /<soft>/);
});
