import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_MIND, type Note } from "../types.ts";
import { buildTail, buildVoiceMessages } from "./pack-build.ts";
import { DEFAULT_PROFILE } from "../../types.ts";

const note: Note = {
  id: "n1",
  text: "她说过难过时想被叫小猫",
  tags: ["偏好"],
  subject: "rosie",
  lens: ["bond"],
  fromRosie: true,
  weight: 4,
  status: "active",
  supersededBy: null,
  links: [],
  happenedAt: Date.UTC(2026, 8, 10),
  localDay: "2026-09-10",
  sourceIds: [],
  recallCount: 0,
  lastRecalledAt: null,
  createdAt: 0,
  updatedAt: 0,
};

test("voice messages keep charter first and tail last before user", () => {
  const msgs = buildVoiceMessages({
    charter: DEFAULT_PROFILE.systemPrompt,
    selfSummary: "我在医学院",
    bondSummary: "叫她小猫",
    portrait: [{ id: "p", topic: "安慰", body: "别讲道理", status: "active", evidenceIds: [], lastSeen: 0, updatedAt: 0 }],
    history: [
      { id: "u1", role: "user", text: "嗯", createdAt: 1, kind: "say", archivedAt: null, sessionId: "s", localDay: "2026-09-15" },
    ],
    tail: "现在是星期二。\n尾巴",
    userText: "今晚不想动",
  });
  assert.equal(msgs[0]!.role, "system");
  assert.match(msgs[0]!.content, /你就是清然/);
  assert.match(msgs[1]!.content, /【我自己】/);
  assert.equal(msgs[2]!.role, "user");
  assert.equal(msgs[2]!.content, "嗯");
  assert.equal(msgs[3]!.role, "system");
  assert.match(msgs[3]!.content, /尾巴/);
  assert.equal(msgs.at(-1)!.role, "user");
  assert.equal(msgs.at(-1)!.content, "今晚不想动");
});

test("empty mind omits inner block but keeps stance lines", () => {
  const tail = buildTail({
    clock: "星期二 21:00",
    mind: EMPTY_MIND,
    notes: [note],
    timeZone: "UTC",
    careHint: false,
  });
  assert.doesNotMatch(tail, /你此刻的内心/);
  assert.match(tail, /你深爱她/);
  assert.match(tail, /说话要有逻辑/);
  assert.match(tail, /小猫/);
});

test("lead_plan and intent survive truncation", () => {
  const mind = {
    ...EMPTY_MIND,
    turn_seq: 1,
    rosie_now: "x".repeat(80),
    undercurrent: "y".repeat(60),
    my_feel: "z".repeat(50),
    my_view: "v".repeat(80),
    my_logic: "l".repeat(100),
    lead_plan: ["带她去床上躺一会儿"],
    intent: "先把灯调暗，再把她揽过来",
    reading: [{ guess: "r".repeat(80), conf: 0.4 }],
    threads: ["论文", "晚饭", "睡眠", "面试"],
  };
  const tail = buildTail({
    clock: "x",
    mind,
    notes: Array.from({ length: 6 }, (_, i) => ({ ...note, id: `n${i}`, text: "记忆".repeat(40) })),
    timeZone: "UTC",
    careHint: false,
  });
  assert.match(tail, /带她去床上躺一会儿/);
  assert.match(tail, /先把灯调暗/);
});

test("care checkin line is opt-in", () => {
  const off = buildTail({ clock: "x", mind: EMPTY_MIND, notes: [], timeZone: "UTC", careHint: false });
  const on = buildTail({ clock: "x", mind: EMPTY_MIND, notes: [], timeZone: "UTC", careHint: true });
  assert.doesNotMatch(off, /今天过得怎么样/);
  assert.match(on, /今天过得怎么样/);
});
