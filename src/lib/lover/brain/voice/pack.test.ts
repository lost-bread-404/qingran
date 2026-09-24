import assert from "node:assert/strict";
import { test } from "node:test";
import { SESSION_GAP_MS, LONGING_TTL_MS } from "../config.ts";
import { momentForVoice } from "../mind-parse.ts";
import { EMPTY_INNER } from "../types.ts";
import {
  buildTail,
  buildVoiceMessages,
  voiceInputChars,
  voiceMessagesForStrip,
  formatVoiceInputCharsLine,
  parseVoiceInputCharsLine,
  stripLabel,
  EMPTY_MOMENT,
  type VoicePackParts,
} from "./pack-build.ts";
import { DEFAULT_PROFILE } from "../../types.ts";

const portrait = {
  id: "p",
  topic: "安慰",
  body: "别讲道理",
  status: "active" as const,
  kind: "trait" as const,
  evidenceIds: [],
  lastSeen: 0,
  lastSupportedAt: 0,
  supportCount: 1,
  updatedAt: 0,
};

test("voice messages keep charter, dossier, then history, clock, and user", () => {
  const msgs = buildVoiceMessages({
    charter: DEFAULT_PROFILE.systemPrompt,
    selfSummary: "我在医学院",
    bondSummary: "叫她小猫",
    portrait: [portrait],
    history: [
      { id: "u1", role: "user", text: "嗯", createdAt: 1, kind: "say", archivedAt: null, sessionId: "s", localDay: "2026-09-15" },
    ],
    userText: "今晚不想动",
    moment: { ...EMPTY_MOMENT, feel: "想靠近" },
    clock: "星期二 21:00",
  });
  assert.equal(msgs[0]!.role, "system");
  assert.match(msgs[0]!.content, /你就是清然/);
  assert.match(msgs[1]!.content, /【我记得的】/);
  assert.match(msgs[1]!.content, /【我自己】/);
  assert.match(msgs[1]!.content, /我在医学院/);
  assert.match(msgs[2]!.content, /【我此刻】/);
  assert.match(msgs[2]!.content, /心里：想靠近/);
  assert.doesNotMatch(msgs[2]!.content, /想要：/);
  assert.equal(msgs[3]!.content, "现在是星期二 21:00。");
  assert.equal(msgs[4]!.content, "嗯");
  assert.equal(msgs.at(-1)!.content, "今晚不想动");
  const joined = msgs.map((m) => m.content).join("\n");
  assert.doesNotMatch(joined, /不要复述/);
  assert.doesNotMatch(joined, /choice/);
});

test("empty moment omits the block but keeps the clock", () => {
  const tail = buildTail({ clock: "星期二 21:00", moment: EMPTY_MOMENT });
  assert.doesNotMatch(tail, /【我此刻】/);
  assert.doesNotMatch(tail, /不要复述/);
  assert.match(tail, /现在是星期二 21:00/);
});

test("moment lines stay in full and choice is not a voice slot", () => {
  const now = "听她把今天说完，再决定要不要靠近。";
  const tail = buildTail({
    clock: "x",
    moment: { feel: "想抱着你", want: "想被需要", now, longing: "" },
  });
  assert.match(tail, /【我此刻】/);
  assert.match(tail, /心里：想抱着你/);
  assert.match(tail, /想要：想被需要/);
  assert.ok(tail.includes(now));
  assert.doesNotMatch(tail, /一直惦记着/);
  assert.doesNotMatch(tail, /不要催/);
});

test("stale moment fields are omitted by momentForVoice", () => {
  const updated = Date.UTC(2026, 8, 15, 14, 0, 0);
  const inner = {
    ...EMPTY_INNER,
    feel: "嘴里长溃疡了也好想抱",
    want: "想留下来",
    now: "先听她说",
    longing: "一直想被她叫姐姐",
    updated_at: updated,
    longing_updated_at: updated,
    turn_seq: 4,
  };
  const stale = momentForVoice(inner, Date.UTC(2026, 8, 16, 19, 0, 0), true);
  assert.equal(stale.feel, "");
  assert.equal(stale.now, "");
  assert.equal(stale.longing, "一直想被她叫姐姐");
  const overLonging = momentForVoice(inner, updated + LONGING_TTL_MS + 1, true);
  assert.equal(overLonging.longing, "");
  const atGap = momentForVoice(inner, updated + SESSION_GAP_MS, true);
  assert.equal(atGap.feel, "嘴里长溃疡了也好想抱");
  const over = momentForVoice(inner, updated + SESSION_GAP_MS + 1, true);
  assert.equal(over.feel, "");
});

function sampleParts(): VoicePackParts {
  return {
    charter: "你就是清然。正在和 Rosie 语音通话。",
    longterm: "【我自己】医学生\n叫她小猫",
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
    moment: { ...EMPTY_MOMENT, now: "听她把累说完" },
    clockText: "星期二 21:00",
    timeZone: "UTC",
    nowMs: 1,
  };
}

test("voiceMessagesForStrip drops moment then dossier then thins history", () => {
  const parts = sampleParts();
  const joined = (strip: "none" | "moment" | "dossier" | "thin") =>
    voiceMessagesForStrip(parts, strip)
      .map((m) => m.content)
      .join("\n");

  assert.match(joined("none"), /【我此刻】/);
  assert.match(joined("none"), /小猫/);
  assert.match(joined("none"), /【我自己】/);

  assert.doesNotMatch(joined("moment"), /【我此刻】/);
  assert.match(joined("moment"), /小猫/);
  assert.match(joined("moment"), /【我自己】/);

  assert.doesNotMatch(joined("dossier"), /小猫/);
  assert.doesNotMatch(joined("dossier"), /【我此刻】/);
  assert.doesNotMatch(joined("dossier"), /【我自己】/);

  const thin = voiceMessagesForStrip(parts, "thin");
  assert.equal(thin[0]!.role, "system");
  assert.match(thin[0]!.content, /你就是清然/);
  assert.doesNotMatch(joined("thin"), /【我自己】/);
  assert.doesNotMatch(joined("thin"), /【我此刻】/);
  assert.equal(thin.length, 1 + 8 + 1);
  assert.equal(thin[1]!.content, "msg4");
  assert.equal(thin.at(-1)!.content, "今晚不想动");
});

test("voiceInputChars splits system moment dossier history user", () => {
  const parts = sampleParts();
  const c = voiceInputChars(parts);
  assert.ok(c.system > 0);
  assert.ok(c.moment > 0);
  assert.ok(c.dossier > 0);
  assert.ok(c.history > 0);
  assert.equal(c.user, "今晚不想动".length);
  const empty = voiceInputChars({ ...parts, moment: EMPTY_MOMENT, longterm: "", injectDossier: false });
  assert.equal(empty.moment, 0);
  assert.equal(empty.dossier, 0);
  const line = formatVoiceInputCharsLine(c);
  assert.match(line, /chars system=\d+ moment=\d+ dossier=\d+ history=\d+ user=\d+/);
  assert.deepEqual(parseVoiceInputCharsLine(line), c);
  assert.deepEqual(parseVoiceInputCharsLine("chars system=1 mind=2 notes=3 history=4 user=5"), {
    system: 1,
    moment: 2,
    dossier: 3,
    history: 4,
    user: 5,
  });
  assert.equal(stripLabel("none"), "未裁剪");
  assert.equal(stripLabel("moment"), "去掉了【我此刻】");
  assert.equal(stripLabel("dossier"), "去掉了【我此刻】和【我记得的】");
});

test("voice inject switches omit moment, dossier, and history independently", () => {
  const base = {
    charter: "你就是清然。",
    selfSummary: "我在医学院",
    bondSummary: "叫她小猫",
    portrait: [portrait],
    history: [
      { id: "u1", role: "user" as const, text: "昨天的事", createdAt: 1, kind: "say" as const, archivedAt: null, sessionId: "s", localDay: "2026-09-15" },
      { id: "a1", role: "assistant" as const, text: "先休息", createdAt: 2, kind: "say" as const, archivedAt: null, sessionId: "s", localDay: "2026-09-15" },
    ],
    userText: "今晚不想动",
    clock: "星期二 21:00",
    moment: { ...EMPTY_MOMENT, feel: "想抱着你" },
  };
  const offMoment = buildVoiceMessages({ ...base, inject: { moment: false, dossier: true, history: 40 } })
    .map((m) => m.content)
    .join("\n");
  assert.doesNotMatch(offMoment, /【我此刻】/);
  assert.doesNotMatch(offMoment, /想抱着你/);
  assert.match(offMoment, /【我自己】/);
  assert.match(offMoment, /我在医学院/);
  assert.match(offMoment, /昨天的事/);

  const offDossier = buildVoiceMessages({ ...base, inject: { moment: true, dossier: false, history: 40 } })
    .map((m) => m.content)
    .join("\n");
  assert.doesNotMatch(offDossier, /【我记得的】/);
  assert.doesNotMatch(offDossier, /我在医学院/);
  assert.doesNotMatch(offDossier, /别讲道理/);
  assert.match(offDossier, /想抱着你/);

  const noHist = buildVoiceMessages({ ...base, inject: { moment: true, dossier: true, history: 0 } });
  assert.equal(noHist.some((m) => m.content === "昨天的事" || m.content === "先休息"), false);
  assert.equal(noHist.at(-1)!.content, "今晚不想动");
  assert.match(noHist.map((m) => m.content).join("\n"), /【我自己】/);
});

test("reply slots keep stored wording; charter, history, and this turn stay", () => {
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
        kind: "trait",
        evidenceIds: [],
        lastSeen: 0,
        lastSupportedAt: 0,
        supportCount: 1,
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
    clock: "星期二 21:00",
    moment: { ...EMPTY_MOMENT, now: "听 Rosie 把今天说完" },
  });
  const joined = msgs.map((m) => m.content).join("\n");
  assert.match(msgs[0]!.content, /你就是清然/);
  assert.match(msgs[0]!.content, /正在和 Rosie 语音通话/);
  assert.match(joined, /清然在医学院/);
  assert.match(joined, /叫她小猫/);
  assert.match(joined, /Rosie 今天日程很满/);
  assert.match(joined, /听 Rosie 把今天说完/);
  assert.equal(msgs.find((m) => m.content === "Rosie 说了这句话")?.role, "user");
  assert.equal(msgs.at(-1)!.content, "清然在吗");
});
