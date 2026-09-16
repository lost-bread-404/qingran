import assert from "node:assert/strict";
import { test } from "node:test";
import MiniSearch from "minisearch";
import { formatIndexLine, tokenizeMemory } from "../text.ts";

test("Chinese tokenizer emits bigrams plus latin words", () => {
  const tokens = tokenizeMemory("Rosie 很难过想被叫小猫");
  assert.ok(tokens.includes("rosie"));
  assert.ok(tokens.includes("难过"));
  assert.ok(tokens.includes("小猫"));
  assert.ok(!tokens.includes("很"));
});

test("MiniSearch finds Chinese query by bigram", () => {
  const mini = new MiniSearch({
    fields: ["text"],
    storeFields: ["id"],
    tokenize: tokenizeMemory,
    processTerm: (t) => t,
  });
  mini.addAll([
    { id: "a", text: "她说过难过时别讲道理，叫她小猫" },
    { id: "b", text: "清然在准备解剖考试" },
  ]);
  const hits = mini.search("叫小猫", { tokenize: tokenizeMemory, processTerm: (t) => t });
  assert.equal(hits[0]?.id, "a");
});

test("index line format", () => {
  assert.equal(
    formatIndexLine({
      id: "n1",
      text: "她喜欢被叫小猫，不想听讲道理的安慰方式",
      subject: "rosie",
      localDay: "2026-09-10",
    }),
    "n1|09-10|rosie|她喜欢被叫小猫，不想听讲道理的安慰方式".slice(0, "n1|09-10|rosie|".length + 30),
  );
});
