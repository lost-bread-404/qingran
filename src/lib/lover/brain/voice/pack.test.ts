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
    userText: "今晚不想动",
  });
  assert.equal(msgs[0]!.role, "system");
  assert.match(msgs[0]!.content, /你就是清然/);
  assert.match(msgs[1]!.content, /【我自己】/);
  assert.equal(msgs[2]!.role, "user");
  assert.equal(msgs[2]!.content, "嗯");
  assert.equal(msgs[3]!.role, "system");
  assert.match(msgs[3]!.content, /说话要有逻辑/);
  assert.equal(msgs.at(-1)!.role, "user");
  assert.equal(msgs.at(-1)!.content, "今晚不想动");
});

test("empty mind omits inner block but keeps the logic line", () => {
  const tail = buildTail({
    clock: "星期二 21:00",
    mind: EMPTY_MIND,
    notes: [note],
    timeZone: "UTC",
    careHint: false,
  });
  assert.doesNotMatch(tail, /【内心】/);
  assert.doesNotMatch(tail, /不要复述/);
  assert.doesNotMatch(tail, /你深爱她/);
  assert.match(tail, /说话要有逻辑/);
  assert.match(tail, /小猫/);
});

test("mind with turn_seq but no insight is omitted", () => {
  const tail = buildTail({
    clock: "x",
    mind: { ...EMPTY_MIND, turn_seq: 1 },
    notes: [],
    timeZone: "UTC",
    careHint: false,
  });
  assert.doesNotMatch(tail, /【内心】/);
});

test("insight is injected in full without ellipsis", () => {
  const insight = "她反复把累说成懒，其实是怕自己不够好。依据是这周三次同样的绕。把握大概七成。";
  const tail = buildTail({
    clock: "x",
    mind: { ...EMPTY_MIND, turn_seq: 1, insight },
    notes: Array.from({ length: 6 }, (_, i) => ({ ...note, id: `n${i}`, text: "记忆".repeat(40) })),
    timeZone: "UTC",
    careHint: false,
  });
  assert.match(tail, /【内心】/);
  assert.match(tail, /你反复把累说成懒/);
  assert.doesNotMatch(tail, /…/);
});

test("care checkin line is opt-in", () => {
  const off = buildTail({ clock: "x", mind: EMPTY_MIND, notes: [], timeZone: "UTC", careHint: false });
  const on = buildTail({ clock: "x", mind: EMPTY_MIND, notes: [], timeZone: "UTC", careHint: true });
  assert.doesNotMatch(off, /今天过得怎么样/);
  assert.match(on, /今天过得怎么样/);
});

test("stale mind is not injected", () => {
  const mind = {
    ...EMPTY_MIND,
    turn_seq: 4,
    updated_at: Date.UTC(2026, 8, 15, 14, 0, 0),
    insight: "她刚说：嘴里长溃疡了好疼，其实是怕自己不够好",
  };
  const tail = buildTail({
    clock: "星期三 19:00",
    mind,
    notes: [],
    timeZone: "UTC",
    careHint: false,
    nowMs: Date.UTC(2026, 8, 16, 19, 0, 0),
  });
  assert.doesNotMatch(tail, /嘴里长溃疡/);
  assert.doesNotMatch(tail, /【内心】/);
  assert.doesNotMatch(tail, /你上次的内心/);
});

test("stale uses strict greater-than session gap", () => {
  const mind = {
    ...EMPTY_MIND,
    turn_seq: 2,
    updated_at: 1,
    insight: "她其实是怕",
  };
  const atGap = buildTail({
    clock: "x",
    mind,
    notes: [],
    timeZone: "UTC",
    careHint: false,
    nowMs: 1 + 30 * 60_000,
  });
  assert.match(atGap, /【内心】/);
  const over = buildTail({
    clock: "x",
    mind,
    notes: [],
    timeZone: "UTC",
    careHint: false,
    nowMs: 1 + 30 * 60_000 + 1,
  });
  assert.doesNotMatch(over, /【内心】/);
});

test("jump does not rewrite the insight block", () => {
  const jumped = {
    ...EMPTY_MIND,
    turn_seq: 3,
    insight: "她把论文卡住说成懒，其实是怕自己不够好",
  };
  const tail = buildTail({
    clock: "星期二 21:00",
    mind: jumped,
    notes: [note],
    timeZone: "UTC",
    careHint: false,
    jump: true,
  });
  assert.match(tail, /【内心】/);
  assert.match(tail, /不要复述，也不要说明自己没做什么/);
  assert.match(tail, /怕自己不够好/);
  assert.doesNotMatch(tail, /刚跳到了新的话题/);
  assert.doesNotMatch(tail, /上面这条路可能不适用了/);
});

function sampleParts(): VoicePackParts {
  const mind = {
    ...EMPTY_MIND,
    turn_seq: 1,
    insight: "她把累说成懒，其实是怕自己不够好",
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

  assert.match(joined("none"), /【内心】/);
  assert.match(joined("none"), /小猫/);
  assert.match(joined("none"), /【我自己】/);

  assert.doesNotMatch(joined("mind"), /【内心】/);
  assert.match(joined("mind"), /小猫/);
  assert.match(joined("mind"), /【我自己】/);

  assert.doesNotMatch(joined("notes"), /小猫/);
  assert.doesNotMatch(joined("notes"), /【内心】/);
  assert.match(joined("notes"), /【我自己】/);

  const thin = voiceMessagesForStrip(parts, "thin");
  assert.equal(thin[0]!.role, "system");
  assert.match(thin[0]!.content, /你就是清然/);
  assert.doesNotMatch(joined("thin"), /【我自己】/);
  assert.doesNotMatch(joined("thin"), /【内心】/);
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

test("voice inject switches omit memories, longterm, and history independently", () => {
  const base = {
    charter: "你就是清然。",
    selfSummary: "我在医学院",
    bondSummary: "叫她小猫",
    portrait: [{ id: "p", topic: "安慰", body: "别讲道理", status: "active" as const, evidenceIds: [], lastSeen: 0, updatedAt: 0 }],
    history: [
      { id: "u1", role: "user" as const, text: "昨天的事", createdAt: 1, kind: "say" as const, archivedAt: null, sessionId: "s", localDay: "2026-09-15" },
      { id: "a1", role: "assistant" as const, text: "先休息", createdAt: 2, kind: "say" as const, archivedAt: null, sessionId: "s", localDay: "2026-09-15" },
    ],
    userText: "今晚不想动",
    notes: [note],
    clock: "星期二 21:00",
    timeZone: "UTC",
    mind: { ...EMPTY_MIND, turn_seq: 1, insight: "她把累说成懒" },
  };
  const offMem = buildVoiceMessages({ ...base, inject: { memories: false, longterm: true, history: 40 } })
    .map((m) => m.content)
    .join("\n");
  assert.doesNotMatch(offMem, /【可以用的记忆】/);
  assert.doesNotMatch(offMem, /难过时想被叫小猫/);
  assert.match(offMem, /【我自己】/);
  assert.match(offMem, /我在医学院/);
  assert.match(offMem, /你把累说成懒/);
  assert.match(offMem, /昨天的事/);

  const offLong = buildVoiceMessages({ ...base, inject: { memories: true, longterm: false, history: 40 } })
    .map((m) => m.content)
    .join("\n");
  assert.doesNotMatch(offLong, /【我自己】/);
  assert.doesNotMatch(offLong, /【我们】/);
  assert.doesNotMatch(offLong, /【我眼中的她】/);
  assert.doesNotMatch(offLong, /我在医学院/);
  assert.doesNotMatch(offLong, /别讲道理/);
  assert.match(offLong, /难过时想被叫小猫/);
  assert.match(offLong, /你把累说成懒/);

  const noHist = buildVoiceMessages({ ...base, inject: { memories: true, longterm: true, history: 0 } });
  assert.equal(noHist.some((m) => m.content === "昨天的事" || m.content === "先休息"), false);
  assert.equal(noHist.at(-1)!.content, "今晚不想动");
  assert.match(noHist.map((m) => m.content).join("\n"), /【我自己】/);
});

test("reply slots are rewritten into 清然's voice; charter, history, and this turn stay", () => {
  const msgs = buildVoiceMessages({
    charter: "你就是清然。正在和 Rosie 语音通话。",
    selfSummary: "清然在医学院",
    bondSummary: "叫她小猫",
    portrait: [
      {
        id: "p",
        topic: "日程",
        body: "Rosie 今天日程很满",
        status: "active",
        evidenceIds: [],
        lastSeen: 0,
        updatedAt: 0,
      },
    ],
    history: [
      {
        id: "u1",
        role: "user",
        text: "Rosie 说了这句话",
        createdAt: 1,
        kind: "say",
        archivedAt: null,
        sessionId: "s",
        localDay: "2026-09-15",
      },
    ],
    userText: "清然在吗",
    notes: [{ ...note, text: "清然承诺陪 Rosie 写完" }],
    clock: "星期二 21:00",
    timeZone: "UTC",
    mind: { ...EMPTY_MIND, turn_seq: 1, insight: "她其实一直在怕" },
  });
  const charter = msgs[0]!.content;
  const longterm = msgs[1]!.content;
  const tail = msgs[3]!.content;
  assert.match(charter, /你就是清然/);
  assert.match(charter, /正在和 Rosie 语音通话/);
  assert.match(longterm, /我在医学院/);
  assert.match(longterm, /叫你小猫/);
  assert.match(longterm, /你今天日程很满/);
  assert.doesNotMatch(longterm, /Rosie|清然/);
  assert.doesNotMatch(longterm, /叫她/);
  assert.match(tail, /我承诺陪你写完/);
  assert.match(tail, /你其实一直在怕/);
  assert.doesNotMatch(tail, /Rosie|清然/);
  assert.equal(msgs[2]!.content, "Rosie 说了这句话");
  assert.equal(msgs.at(-1)!.content, "清然在吗");
});

