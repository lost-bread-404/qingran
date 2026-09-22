import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRememberPrompt, promptFingerprint } from "./prompt.ts";
import { defaultPrompt } from "./brain/prompts/catalog.ts";
import { fillTemplate } from "./brain/prompts/fill.ts";

test("hearing tag guide describes sound, not emotion classes", () => {
  const text = promptFingerprint("你就是清然。");
  assert.match(text, /字〔长短·走向·声线｜事件〕/);
  assert.match(text, /cry\+moan/);
  assert.match(text, /meow/);
  assert.match(text, /猫叫/);
  assert.match(text, /coy/);
  assert.match(text, /撒娇/);
  assert.match(text, /意思由你根据上下文判断/);
  assert.doesNotMatch(text, /playful|玩\/满足/);
});

test("remember prompt is the catalog template filled in", () => {
  const out = buildRememberPrompt("今晚提分手", []);
  assert.equal(
    out,
    fillTemplate(defaultPrompt("remember"), { memories: "（还没有）", stretch: "今晚提分手" }),
  );
});
