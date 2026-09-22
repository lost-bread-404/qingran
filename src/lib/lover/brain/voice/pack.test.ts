import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_MIND, type Note } from "../types.ts";
import {
  buildTail,
  buildVoiceMessages,
  voiceInputChars,
  voiceMessagesForStrip,
  formatVoiceInputCharsLine,
  parseVoiceInputCharsLine,
  stripLabel,
  type VoicePackParts,
} from "./pack-build.ts";
import { DEFAULT_PROFILE } from "../../types.ts";

const note: Note = {
  id: "n1",
  text: "她说过难过时想被叫小猫",
  tags: ["偏好"],
  aliases: [],
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

test("stale mind omits intent and rosie_now and explains the gap", () => {
  const mind = {
    ...EMPTY_MIND,
    turn_seq: 4,
    updated_at: Date.UTC(2026, 8, 15, 14, 0, 0),
    rosie_now: "她刚说：嘴里长溃疡了好疼",
    undercurrent: "她其实是怕自己不够好",
    my_view: "熬夜换不来安全感",
    lead_plan: ["今晚让她 1 点前睡"],
    intent: "温柔但坚定地让她放下手机",
    threads: ["周五 Citadel 面试"],
  };
  const tail = buildTail({
    clock: "星期三 19:00",
    mind,
    notes: [],
    timeZone: "UTC",
    careHint: false,
    nowMs: Date.UTC(2026, 8, 16, 19, 0, 0),
  });
  assert.doesNotMatch(tail, /她刚说：嘴里长溃疡了好疼/);
  assert.doesNotMatch(tail, /温柔但坚定地让她放下手机/);
  assert.doesNotMatch(tail, /你此刻的内心/);
  assert.match(tail, /你上次的内心/);
  assert.match(tail, /小时前的想法|天前的想法/);
  assert.match(tail, /先重新感受她现在的状态/);
  assert.match(tail, /今晚让她 1 点前睡/);
});

test("stale uses strict greater-than session gap", () => {
  const mind = {
    ...EMPTY_MIND,
    turn_seq: 2,
    updated_at: 1,
    undercurrent: "怕",
    my_view: "要睡",
    lead_plan: ["早点睡"],
    intent: "拉她去睡觉",
    rosie_now: "她刚说累",
  };
  const atGap = buildTail({
    clock: "x",
    mind,
    notes: [],
    timeZone: "UTC",
    careHint: false,
    nowMs: 1 + 30 * 60_000,
  });
  assert.match(atGap, /你此刻的内心/);
  const over = buildTail({
    clock: "x",
    mind,
    notes: [],
    timeZone: "UTC",
    careHint: false,
    nowMs: 1 + 30 * 60_000 + 1,
  });
  assert.match(over, /你上次的内心/);
});

test("jump replaces the inner hint and flags the old road without dropping fields", () => {
  const jumped = {
    ...EMPTY_MIND,
    turn_seq: 3,
    rosie_now: "她刚说论文写不下去",
    undercurrent: "怕自己不够好",
    my_feel: "心疼",
    my_view: "先睡",
    my_logic: "焦虑 → 熬夜",
    lead_plan: ["今晚让她早点睡"],
    intent: "把她拉去睡觉",
    threads: ["论文"],
  };
  const tail = buildTail({
    clock: "星期二 21:00",
    mind: jumped,
    notes: [note],
    timeZone: "UTC",
    careHint: false,
    jump: true,
  });
  assert.match(tail, /你此刻的内心/);
  assert.match(tail, /她刚跳到了新的话题/);
  assert.match(tail, /先跟上她/);
  assert.match(tail, /上面这条路可能不适用了/);
  assert.match(tail, /今晚让她早点睡/);
  assert.match(tail, /把她拉去睡觉/);
  assert.match(tail, /她刚说论文写不下去/);
  assert.doesNotMatch(tail, /如果她这句话改变了情况/);
});

test("jump does not rewrite the stale branch", () => {
  const mind = {
    ...EMPTY_MIND,
    turn_seq: 4,
    updated_at: Date.UTC(2026, 8, 15, 14, 0, 0),
    rosie_now: "她刚说：嘴里长溃疡了好疼",
    undercurrent: "她其实是怕自己不够好",
    my_view: "熬夜换不来安全感",
    lead_plan: ["今晚让她 1 点前睡"],
    intent: "温柔但坚定地让她放下手机",
    threads: ["周五 Citadel 面试"],
  };
  const tail = buildTail({
    clock: "星期三 19:00",
    mind,
    notes: [],
    timeZone: "UTC",
    careHint: false,
    nowMs: Date.UTC(2026, 8, 16, 19, 0, 0),
    jump: true,
  });
  assert.match(tail, /你上次的内心/);
  assert.doesNotMatch(tail, /刚跳到了新的话题/);
  assert.doesNotMatch(tail, /上面这条路可能不适用了/);
});

function sampleParts(): VoicePackParts {
  const mind = {
    ...EMPTY_MIND,
    turn_seq: 1,
    rosie_now: "她刚说累",
    undercurrent: "怕自己不够好",
    my_feel: "心疼",
    my_view: "先睡",
    my_logic: "累了就该停",
    lead_plan: ["去躺一会儿"],
    intent: "把她揽过来",
  };
  return {
    charter: "你就是清然。正在和 Rosie 语音通话。",
    longterm: "【我自己】医学生",
    history: Array.from({ length: 12 }, (_, i) => ({
      id: `m${i}`,
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: `msg${i}`,
      createdAt: i,
      kind: "say" as const,
      archivedAt: null,
      sessionId: "s",
      localDay: "2026-09-15",
    })),
    userText: "今晚不想动",
    mind,
    notes: [note],
    clockText: "星期二 21:00",
    timeZone: "UTC",
    careHint: false,
    nowMs: 1,
    mindStale: false,
    jump: false,
  };
}

test("voiceMessagesForStrip drops mind then notes then thins history", () => {
  const parts = sampleParts();
  const joined = (strip: "none" | "mind" | "notes" | "thin") =>
    voiceMessagesForStrip(parts, strip)
      .map((m) => m.content)
      .join("\n");

  assert.match(joined("none"), /你此刻的内心/);
  assert.match(joined("none"), /小猫/);
  assert.match(joined("none"), /【我自己】/);

  assert.doesNotMatch(joined("mind"), /你此刻的内心/);
  assert.match(joined("mind"), /小猫/);
  assert.match(joined("mind"), /【我自己】/);

  assert.doesNotMatch(joined("notes"), /小猫/);
  assert.doesNotMatch(joined("notes"), /你此刻的内心/);
  assert.match(joined("notes"), /【我自己】/);

  const thin = voiceMessagesForStrip(parts, "thin");
  assert.equal(thin[0]!.role, "system");
  assert.match(thin[0]!.content, /你就是清然/);
  assert.doesNotMatch(joined("thin"), /【我自己】/);
  assert.doesNotMatch(joined("thin"), /你此刻的内心/);
  assert.equal(thin.length, 1 + 8 + 1);
  assert.equal(thin[1]!.content, "msg4");
  assert.equal(thin.at(-1)!.content, "今晚不想动");
});

test("voiceInputChars splits system mind notes history user", () => {
  const parts = sampleParts();
  const c = voiceInputChars(parts);
  assert.ok(c.system > 0);
  assert.ok(c.mind > 0);
  assert.ok(c.notes > 0);
  assert.ok(c.history > 0);
  assert.equal(c.user, "今晚不想动".length);
  const emptyMind = voiceInputChars({ ...parts, mind: EMPTY_MIND, notes: [] });
  assert.equal(emptyMind.mind, 0);
  assert.equal(emptyMind.notes, 0);
  const line = formatVoiceInputCharsLine(c);
  assert.match(line, /chars system=\d+ mind=\d+ notes=\d+ history=\d+ user=\d+/);
  assert.deepEqual(parseVoiceInputCharsLine(line), c);
  assert.equal(stripLabel("none"), "未裁剪");
  assert.equal(stripLabel("mind"), "去掉了 mind");
});

