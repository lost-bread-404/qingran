import assert from "node:assert/strict";
import { test } from "node:test";
import { extractTfIdfTerms, tokenize } from "./keyterms.ts";

test("tf-idf prefers repeated proper terms over stopwords", () => {
  const docs = [
    { text: "林泽从房子里搬出去了" },
    { text: "林泽后来又回来住" },
    { text: "Hopkins 的课很忙 Hopkins" },
    { text: "今天没有什么事情" },
  ];
  const terms = extractTfIdfTerms(docs, 10);
  assert.ok(terms.includes("林泽"));
  assert.ok(terms.includes("Hopkins"));
  assert.ok(!terms.includes("今天"));
  assert.ok(!terms.includes("没有"));
  assert.equal(extractTfIdfTerms(docs, 10).join(","), terms.join(","));
});

test("tokenize skips short and stop words", () => {
  const tokens = tokenize("今天 Rosie 清然 没有 林泽");
  assert.ok(tokens.includes("Rosie"));
  assert.ok(tokens.includes("清然"));
  assert.ok(tokens.includes("林泽"));
  assert.ok(!tokens.includes("今天"));
});
