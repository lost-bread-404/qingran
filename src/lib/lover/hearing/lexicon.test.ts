import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPersonalLexicon, lexiconPhrase, lexiconWords } from "./lexicon.ts";

test("lexicon keeps 2–6 char words and drops stopwords", () => {
  const words = lexiconWords("今天清然叫 Rosie 小猫 没有 林泽住在隔壁");
  assert.ok(words.includes("清然"));
  assert.ok(words.includes("小猫"));
  assert.ok(words.includes("Rosie"));
  assert.ok(words.includes("林泽"));
  assert.ok(words.includes("住在隔壁") || words.includes("隔壁"));
  assert.ok(!words.includes("今天"));
  assert.ok(!words.includes("没有"));
});

test("personal lexicon ranks words and repeated short phrases", () => {
  const entries = buildPersonalLexicon([
    { text: "我想你了" },
    { text: "我想你了" },
    { text: "我想你了" },
    { text: "清然在吗" },
    { text: "清然在吗" },
    { text: "今天没有什么事情" },
    { text: "Hopkins 的课 Hopkins" },
  ]);
  const words = entries.filter((row) => row.kind === "word").map((row) => row.term);
  const phrases = entries.filter((row) => row.kind === "phrase");
  assert.ok(words.includes("清然"));
  assert.ok(words.includes("Hopkins"));
  assert.ok(!words.includes("今天"));
  assert.ok(phrases.some((row) => row.term === "我想你了" && row.count === 3));
  assert.equal(
    phrases.some((row) => row.term === "清然在吗"),
    false,
  );
  assert.equal(lexiconPhrase("我想你了"), "我想你了");
  assert.equal(lexiconPhrase("短"), null);
});
