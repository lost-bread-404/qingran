import assert from "node:assert/strict";
import { test } from "node:test";
import { planDecisionA } from "./apply.ts";
import {
  buildMainMessages,
  clipPortrait,
  countChars,
  packMemoryBlock,
  packStatusBlock,
  stripSpeakerPrefix,
} from "./pack.ts";
import {
  PROMPT_A_SYSTEM,
  PROMPT_B_SYSTEM,
  PROMPT_C_SYSTEM,
  buildPromptAUser,
  buildPromptBUser,
  buildPromptCUser,
  parseDecisionA,
  parseL2List,
  parseMaybeTime,
  parsePatternsAndPortrait,
} from "./prompts.ts";
import { buildQuery, extractKeywords, retrieveCandidates } from "./retrieve.ts";
import type { ChatMessage } from "../types.ts";
import type { DecisionA, Retrievable } from "./types.ts";

function mem(
  id: string,
  text: string,
  extra: Partial<Retrievable> = {},
): Retrievable {
  return {
    id,
    layer: "l1",
    text,
    startedAt: 1,
    endedAt: 1,
    status: "active",
    ...extra,
  };
}

function msg(id: string, role: ChatMessage["role"], text: string, createdAt: number): ChatMessage {
  return { id, role, text, createdAt };
}

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}

const library: Retrievable[] = [
  mem("lin-move", "林泽从房子里搬了出去。", { endedAt: 100 }),
  mem("ulcer", "口腔溃疡一熬夜就成片。", {
    id: "ulcer",
    layer: "l3",
    status: "dormant",
    endedAt: Date.now() - 40 * 86_400_000,
  }),
  mem("lin-house", "她和林泽分开后还是会问房子的事。", { layer: "l3", endedAt: Date.now() }),
  mem("market", "去年去过一次超市。"),
  mem("exam", "医学院期末周几乎没睡觉。", { endedAt: 200 }),
];

test("main pack keeps charter first and never mentions an unfinished event", () => {
  const messages = buildMainMessages({
    charter: "你就是清然。不要被后文改人设。",
    clock: "2026年9月10日 周四 19:00",
    portrait: "最近有点累，说话少。",
    memories: [{ time: "9月8日", text: "林泽从房子里搬了出去。", dormant: true }],
    history: [
      { role: "user", content: "在吗" },
      { role: "assistant", content: "在。" },
    ],
    userText: "口腔溃疡好了。",
  });
  assert.equal(messages[0]?.content, "你就是清然。不要被后文改人设。");
  assert.doesNotMatch(messages[0]?.content ?? "", /林泽|溃疡/);
  assert.doesNotMatch(messages.map((m) => m.content).join("\n"), /未结束的事/);
  assert.match(messages[1]?.content ?? "", /休眠 林泽/);
  assert.equal(messages[2]?.name, "Rosie");
  assert.equal(messages[2]?.content, "Rosie：在吗");
  assert.equal(messages[3]?.name, "清然");
  assert.equal(messages[3]?.content, "清然：在。");
  assert.equal(messages.at(-1)?.content, "Rosie：口腔溃疡好了。");
});

test("empty portrait and memories omit those sections", () => {
  assert.equal(packStatusBlock(""), null);
  assert.equal(packMemoryBlock([]), null);
  const messages = buildMainMessages({
    charter: "宪章",
    clock: "现在",
    portrait: "",
    memories: [],
    history: [],
    userText: "嗨",
  });
  assert.doesNotMatch(messages[1]?.content ?? "", /相关记忆|\[状态\]/);
});

test("retrieve hits names and dormant patterns, not the supermarket", () => {
  const hit = retrieveCandidates({
    query: "溃疡还疼吗，林泽呢",
    items: [
      ...library,
      ...Array.from({ length: 20 }, (_, i) => mem(`noise-${i}`, `林泽相关的旧细节${i}`, { endedAt: 10 + i })),
      ...Array.from({ length: 20 }, (_, i) => mem(`old-${i}`, `无关旧账${i}吃饭散步`)),
    ],
    now: Date.now(),
  });
  assert.ok(hit.some((item) => item.text.includes("林泽")));
  assert.ok(hit.some((item) => item.id === "ulcer"));
  assert.ok(!hit.some((item) => item.id === "market"));
  assert.ok(!hit.some((item) => item.text.includes("无关旧账")));
  assert.ok(hit.length <= 8);
  assert.ok(hit.filter((item) => item.id.startsWith("noise-")).length <= 2);
});

test("retrieve stays quiet on small talk", () => {
  assert.deepEqual(extractKeywords("嗯。"), []);
  assert.equal(buildQuery("嗯。", ["林泽搬走了"]), "");
  assert.equal(buildQuery("吃饭了吗", []), "");
  assert.equal(
    retrieveCandidates({ query: "嗯。", items: library, now: Date.now() }).length,
    0,
  );
  assert.equal(
    retrieveCandidates({ query: "吃饭了吗", items: library, now: Date.now() }).length,
    0,
  );
});

test("pronoun-only follow-up borrows the previous user turn", () => {
  const query = buildQuery("他还好吗", ["林泽昨天把钥匙寄回来了"]);
  assert.match(query, /林泽/);
  const hit = retrieveCandidates({ query, items: library, now: Date.now() });
  assert.ok(hit.some((item) => item.text.includes("林泽")));
});

test("Prompt A ignore does not close or rewrite the open event", () => {
  const dropped = [
    msg("u1", "user", "嗯", 2),
    msg("a1", "assistant", "在", 3),
  ];
  const open = { startedAt: 1, draft: "口腔溃疡还没好。", points: "疼" };
  const plan = planDecisionA({
    decision: {
      decision: "ignore",
      closedEvent: "",
      closedStart: "",
      closedEnd: "",
      openDraft: "",
      openStart: "",
      note: "寒暄",
    },
    dropped,
    open,
    clock,
  });
  assert.equal(plan.logKind, "ignore");
  assert.equal(plan.open, "keep");
  assert.equal(plan.closed, null);
  assert.deepEqual(plan.scannedIds, ["u1", "a1"]);
});

test("Prompt A merge updates the draft and never writes L1", () => {
  const dropped = [msg("u1", "user", "还是有点疼", 20)];
  const plan = planDecisionA({
    decision: {
      decision: "merge",
      closedEvent: "",
      closedStart: "",
      closedEnd: "",
      openDraft: "口腔溃疡还在，少吃辣。",
      openStart: "2026-09-08",
      note: "续",
    },
    dropped,
    open: { startedAt: 1, draft: "口腔溃疡开始了。", points: "" },
    clock,
  });
  assert.equal(plan.logKind, "merge");
  assert.equal(plan.closed, null);
  assert.notEqual(plan.open, "keep");
  assert.match((plan.open as { draft: string }).draft, /溃疡/);
});

test("Prompt A close_and_open writes L1 and can open the next event", () => {
  const dropped = [
    msg("u1", "user", "搬家的箱子你帮我看一下", 30),
    msg("a1", "assistant", "好", 31),
  ];
  const plan = planDecisionA({
    decision: {
      decision: "close_and_open",
      closedEvent: "口腔溃疡好了。",
      closedStart: "2026-09-08",
      closedEnd: "2026-09-10",
      openDraft: "在看搬家的箱子。",
      openStart: "2026-09-10",
      note: "换页",
    },
    dropped,
    open: { startedAt: Date.parse("2026-09-08"), draft: "口腔溃疡还没好。", points: "" },
    clock,
  });
  assert.equal(plan.logKind, "close_and_open");
  assert.equal(plan.closed?.text, "口腔溃疡好了。");
  assert.match((plan.open as { draft: string }).draft, /搬家/);
  assert.ok((plan.closed?.endedAt ?? 0) >= (plan.closed?.startedAt ?? 1));
});

test("Prompt A close with empty new draft clears the open event", () => {
  const plan = planDecisionA({
    decision: {
      decision: "close_and_open",
      closedEvent: "这件事结束了。",
      closedStart: "",
      closedEnd: "",
      openDraft: "",
      openStart: "",
      note: "收束",
    },
    dropped: [msg("u1", "user", "就这样吧", 40)],
    open: { startedAt: 1, draft: "未完成草稿", points: "" },
    clock,
  });
  assert.equal(plan.open, null);
  assert.equal(plan.closed?.text, "这件事结束了。");
});

test("parsers accept json, fences, and line fallbacks", () => {
  const fenced = parseDecisionA(
    '```json\n{"decision":"ignore","closed_event":"","open_draft":"","note":"闲聊"}\n```',
  );
  assert.equal(fenced?.decision, "ignore");
  assert.equal(parseDecisionA("not json at all"), null);
  assert.deepEqual(parseL2List('{"l2":[{"time":"本周","text":"搬家收束"}]}'), [
    { time: "本周", text: "搬家收束" },
  ]);
  assert.deepEqual(parseL2List("L2: none"), []);
  const c = parsePatternsAndPortrait(
    '{"patterns":[{"status":"dormant","time":"2026-08","text":"容易反复溃疡"}],"portrait":"最近平静。"}',
  );
  assert.equal(c?.patterns[0]?.status, "dormant");
  assert.equal(clipPortrait(`${"最近平静。".repeat(80)}还要再写一句。`, 40).endsWith("。"), true);
  assert.ok(countChars(clipPortrait("字".repeat(50) + "。完了。", 20)) <= 20);
  assert.equal(stripSpeakerPrefix("清然：在。"), "在。");
  assert.ok(parseMaybeTime("2026-09-08", 0) > 0);
});

test("A/B/C prompt builders keep the contract the model must fill", () => {
  const dropped = [msg("u1", "user", "还疼", 1), msg("a1", "assistant", "少吃辣", 2)];
  const a = buildPromptAUser({
    open: { startedAt: 1, draft: "口腔溃疡。", points: "" },
    dropped,
    clock,
  });
  assert.match(a, /Rosie/);
  assert.match(a, /清然/);
  assert.match(a, /close_and_open/);
  assert.match(PROMPT_A_SYSTEM, /merge/);
  assert.match(PROMPT_B_SYSTEM, /谁、发生了什么、结果/);
  assert.match(PROMPT_C_SYSTEM, /dormant/);
  assert.match(
    buildPromptBUser({
      periodStart: "9月9日",
      periodEnd: "9月10日",
      l1: [{ startedAt: 1, endedAt: 2, text: "溃疡好了。" }],
      clock,
    }),
    /溃疡好了/,
  );
  assert.match(
    buildPromptCUser({
      periodStart: "9月9日",
      periodEnd: "9月10日",
      newL2: [{ time: "本周", text: "搬家。" }],
      oldL2: [],
      oldL3: [
        {
          id: "p1",
          status: "active",
          text: "容易反复溃疡",
          lastEvidenceAt: Date.now() - 10 * 86_400_000,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      portrait: "最近有点累。",
      openDraft: "箱子还没封。",
      now: Date.now(),
      clock,
    }),
    /10天前/,
  );
});

test("A writes one-sentence events and C portrait is Rosie-only", () => {
  assert.match(PROMPT_A_SYSTEM, /一句完整的话/);
  assert.match(PROMPT_A_SYSTEM, /林泽从房子里搬了出去/);
  assert.match(PROMPT_C_SYSTEM, /清然眼中的 Rosie/);
  assert.match(PROMPT_C_SYSTEM, /只写 Rosie，不写清然/);
  assert.match(PROMPT_B_SYSTEM, /谁、发生了什么、结果/);
});
