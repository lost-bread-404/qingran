import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_MIND } from "../types.ts";
import { validateMind } from "../mind-parse.ts";

test("validateMind fills missing fields from previous mind", () => {
  const prev = {
    ...EMPTY_MIND,
    rosie_now: "她有点累",
    lead_plan: ["先让她靠过来"],
    intent: "把声音放轻",
    memory_ids: ["old"],
  };
  const next = validateMind(
    { intent: "今晚带她去洗澡", memory_ids: ["n1", "ghost"] },
    prev,
    new Set(["n1"]),
  );
  assert.equal(next.rosie_now, "她有点累");
  assert.deepEqual(next.lead_plan, ["先让她靠过来"]);
  assert.equal(next.intent, "今晚带她去洗澡");
  assert.deepEqual(next.memory_ids, ["n1"]);
  assert.deepEqual(next.recent_intents, ["今晚带她去洗澡"]);
});

test("conf is clamped and lead_plan empty keeps old", () => {
  const next = validateMind(
    {
      reading: [{ guess: "想被哄", conf: 4 }, { guess: "", conf: 0.2 }],
      lead_plan: [],
      rosie_now: "x".repeat(200),
    },
    { ...EMPTY_MIND, lead_plan: ["旧计划"] },
    new Set(),
  );
  assert.equal(next.reading[0]!.conf, 1);
  assert.equal(next.reading.length, 1);
  assert.deepEqual(next.lead_plan, ["旧计划"]);
  assert.ok(next.rosie_now.length <= 80);
});
