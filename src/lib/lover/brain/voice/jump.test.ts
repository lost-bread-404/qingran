import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_MIND, type Mind } from "../types.ts";
import { topicJump } from "./jump.ts";
import { tokenizeMemory } from "../text.ts";

function mind(partial: Partial<Mind>): Mind {
  return { ...EMPTY_MIND, turn_seq: 1, ...partial };
}

test("topicJump cold-starts when mind is empty", () => {
  const long = "今晚想吃火锅然后去看电影";
  assert.ok(new Set(tokenizeMemory(long)).size >= 4);
  const r = topicJump(long, EMPTY_MIND);
  assert.equal(r.score, 1);
  assert.equal(r.jump, false);
});

test("topicJump cold-starts when B is empty even if mind has other fields", () => {
  const r = topicJump("今晚想吃火锅然后去看电影", mind({ my_feel: "心疼", my_view: "要睡" }));
  assert.equal(r.score, 1);
  assert.equal(r.jump, false);
});

test("topicJump cold-starts when the utterance has fewer than 4 tokens", () => {
  const r = topicJump("嗯", mind({ rosie_now: "她在写论文写不下去", threads: ["论文"], intent: "让她先睡" }));
  assert.equal(r.score, 1);
  assert.equal(r.jump, false);
});

test("topicJump is true when this utterance barely overlaps the old mind", () => {
  const r = topicJump(
    "今晚想吃火锅然后去看那部新电影",
    mind({
      rosie_now: "她论文还是一个字都没写",
      undercurrent: "她其实是怕自己不够好",
      threads: ["论文", "Citadel面试"],
      lead_plan: ["今晚让她早点睡"],
      intent: "把她拉去睡觉",
    }),
  );
  assert.ok(r.score < 0.12, `score=${r.score}`);
  assert.equal(r.jump, true);
});

test("topicJump is false when this utterance is still the same topic", () => {
  const r = topicJump(
    "论文还是一个字都没写，今晚先睡吧",
    mind({
      rosie_now: "她论文还是一个字都没写",
      undercurrent: "她其实是怕自己不够好",
      threads: ["论文"],
      lead_plan: ["今晚让她早点睡"],
      intent: "把她拉去睡觉",
    }),
  );
  assert.ok(r.score >= 0.12, `score=${r.score}`);
  assert.equal(r.jump, false);
});
