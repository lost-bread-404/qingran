import assert from "node:assert/strict";
import { test } from "node:test";
import { promptFingerprint } from "./prompt.ts";

test("hearing tag guide describes sound, not emotion classes", () => {
  const text = promptFingerprint("你就是清然。");
  assert.match(text, /字〔长短·走向·声线｜事件〕/);
  assert.match(text, /cry\+moan/);
  assert.match(text, /意思由你根据上下文判断/);
  assert.doesNotMatch(text, /coy|playful|撒娇|玩\/满足/);
});
