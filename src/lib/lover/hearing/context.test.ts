import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildHearingContext,
  extractContextKeyterms,
  mergeKeyterms,
  stripAltTags,
  stripHearingMarkup,
} from "./context.ts";

test("context uses last four turns and last assistant line", () => {
  const block = buildHearingContext([
    { role: "user", text: "一" },
    { role: "assistant", text: "二" },
    { role: "user", text: "三" },
    { role: "assistant", text: "四" },
    { role: "user", text: "Rosie〔long·flat·normal｜neutral〕" },
    { role: "assistant", text: "清然在。" },
  ]);
  assert.match(block, /Rosie：Rosie/);
  assert.match(block, /清然上一句：清然在。/);
  assert.doesNotMatch(block, /：一/);
  assert.match(block, /不要凭上下文补全/);
});

test("keyterms come from names in context and stay within api limits", () => {
  const terms = extractContextKeyterms('清然叫林泽。Rosie said "Hopkins"。');
  assert.ok(terms.includes("Rosie"));
  assert.ok(terms.includes("Hopkins"));
  assert.ok(terms.includes("林泽"));
  const merged = mergeKeyterms(["清然"], terms, ["x".repeat(60)]);
  assert.ok(merged.every((t) => t.length <= 50));
  assert.ok(merged.length <= 100);
});

test("alt tags pick the first candidate for display", () => {
  assert.equal(stripAltTags("今{天|填}好累"), "今天好累");
  assert.equal(stripHearingMarkup("嗯〔long·rising·breathy｜coy〕今{天|填}"), "嗯今天");
});
