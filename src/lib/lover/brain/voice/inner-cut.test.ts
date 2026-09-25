import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultPrompt } from "../prompts/catalog.ts";
import { REFLECT_OUTPUT_KEYS } from "../mind-parse.ts";
import { InnerCutBuffer, replyBodyMissing } from "./inner-cut.ts";

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

test("reflect fields stay in the order the inner prompt asks for", () => {
  assert.deepEqual(REFLECT_OUTPUT_KEYS.slice(0, 10), [
    "desire",
    "read_her",
    "feel",
    "choice",
    "now",
    "longings",
    "plans",
    "scene",
    "glow",
    "next_reach",
  ]);
  const body = defaultPrompt("reflect");
  let at = -1;
  for (const key of ["desire", "read_her", "feel", "choice", "now", "longings", "plans", "scene", "glow", "next_reach"]) {
    const next = body.indexOf(key);
    assert.ok(next > at, key);
    at = next;
  }
});

test("a tail after the mark is not speech", () => {
  const cut = new InnerCutBuffer();
  const visible = cut.push("过来。\n⟦心⟧{\"desire\":\"想抱\",\"choice\":\"不追问\"}");
  assert.equal(visible, "过来。\n");
  assert.equal(cut.speech.includes("不追问"), false);
  assert.equal(cut.speech.includes("想抱"), false);
  assert.match(cut.tail, /不追问/);
});
