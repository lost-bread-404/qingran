import assert from "node:assert/strict";
import { test } from "node:test";
import { promptFingerprint } from "./prompt.ts";

test("voice prompt no longer teaches acoustic tags", () => {
  const text = promptFingerprint("你就是清然。");
  assert.match(text, /\{A\|B\}/);
  assert.doesNotMatch(text, /字〔长短·走向·声线｜事件〕/);
  assert.doesNotMatch(text, /没有标记就按普通口语听/);
  assert.doesNotMatch(text, /cry\+moan/);
});
