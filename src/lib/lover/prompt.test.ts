import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRememberPrompt, promptFingerprint } from "./prompt.ts";
import { defaultPrompt } from "./brain/prompts/catalog.ts";
import { fillTemplate } from "./brain/prompts/fill.ts";

test("voice prompt no longer teaches acoustic tags", () => {
  const text = promptFingerprint("你就是清然。");
  assert.match(text, /\{A\|B\}/);
  assert.doesNotMatch(text, /字〔长短·走向·声线｜事件〕/);
  assert.doesNotMatch(text, /没有标记就按普通口语听/);
  assert.doesNotMatch(text, /cry\+moan/);
});

test("remember prompt is the catalog template filled in", () => {
  const out = buildRememberPrompt("今晚提分手", []);
  assert.equal(
    out,
    fillTemplate(defaultPrompt("remember"), { memories: "（还没有）", stretch: "今晚提分手" }),
  );
});
