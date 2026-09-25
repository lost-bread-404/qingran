import assert from "node:assert/strict";
import { test } from "node:test";
import { VOICE_STATE_BLOCK } from "../prompts/templates.ts";
import { REFLECT_OUTPUT_KEYS } from "../mind-parse.ts";
import { InnerCutBuffer, parseInnerPayload, replyBodyMissing } from "./inner-cut.ts";

test("the mark can be split across chunks and the tail never becomes speech", () => {
  const cut = new InnerCutBuffer();
  const shown: string[] = [];
  const spoken: string[] = [];
  for (const chunk of ["晚", "上好", "⟦", "心", "⟧{\"desire\":\"想抱\"}"]) {
    const visible = cut.push(chunk);
    if (visible) {
      shown.push(visible);
      spoken.push(visible);
    }
  }
  cut.finish();
  assert.equal(shown.join(""), "晚上好");
  assert.equal(spoken.join(""), "晚上好");
  assert.equal(cut.speech, "晚上好");
  assert.equal(cut.tail, "{\"desire\":\"想抱\"}");
  assert.equal(cut.speech.includes("⟦"), false);
  assert.equal(cut.speech.includes("想抱"), false);
});

test("a held prefix that is not the mark is spoken at the end", () => {
  const cut = new InnerCutBuffer();
  assert.equal(cut.push("过来⟦"), "过来");
  assert.equal(cut.finish(), "⟦");
  assert.equal(cut.seen, false);
  assert.equal(cut.speech, "过来⟦");
});

test("a mark with an empty body is a failed reply", () => {
  const cut = new InnerCutBuffer();
  assert.equal(cut.push("⟦心⟧{\"desire\":\"x\"}"), "");
  assert.equal(replyBodyMissing(cut.speech, cut.seen), true);
  assert.match(cut.tail, /desire/);
});

test("inner JSON fields stay in the order the model is asked to write", () => {
  assert.deepEqual(REFLECT_OUTPUT_KEYS.slice(0, 9), [
    "desire",
    "read_her",
    "feel",
    "choice",
    "now",
    "longings",
    "plans",
    "glow",
    "next_reach",
  ]);
  let at = -1;
  for (const key of REFLECT_OUTPUT_KEYS) {
    const next = VOICE_STATE_BLOCK.indexOf(key);
    assert.ok(next > at, key);
    at = next;
  }
});

test("missing fields and broken JSON do not parse", () => {
  const good = parseInnerPayload(
    '\n{"desire":"a","read_her":"b","feel":"c","choice":"d","now":"我问","longings":[],"plans":[],"glow":{"delta":0,"why":""},"next_reach":null}',
  );
  assert.equal(good.ok, true);
  assert.equal(parseInnerPayload("not json").ok, false);
  const partial = parseInnerPayload('{"desire":"a"}');
  assert.equal(partial.ok, false);
  if (!partial.ok) assert.equal(partial.reason, "missing");
});
