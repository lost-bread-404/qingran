import assert from "node:assert/strict";
import { test } from "node:test";
import { planDecisionA } from "./apply.ts";
import {
  PROMPT_A_SYSTEM,
  PROMPT_B_SYSTEM,
  PROMPT_C_SYSTEM,
  buildPromptAUser,
  buildPromptBUser,
  buildPromptCUser,
  parseDecisionA,
  parseL2List,
  parsePatternsAndPortrait,
} from "./prompts.ts";
import type { ChatMessage } from "../types.ts";

const MODEL = "grok-4.20-0309-non-reasoning";
const hasKey = Boolean(process.env.XAI_API_KEY);

function msg(id: string, role: ChatMessage["role"], text: string, createdAt: number): ChatMessage {
  return { id, role, text, createdAt };
}

function clock(ms: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

async function ask(system: string, user: string, temperature: number): Promise<string> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error("no-key");
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature,
      max_tokens: 900,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(25_000),
  });
  assert.equal(res.ok, true, `xAI ${res.status}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = body.choices?.[0]?.message?.content ?? "";
  assert.ok(text.trim(), "empty model output");
  return text;
}

test("live A ignores small talk and leaves the open event alone", { skip: !hasKey, timeout: 30_000 }, async () => {
  const dropped = [msg("u1", "user", "嗯", Date.parse("2026-09-10T12:00:00Z")), msg("a1", "assistant", "在。", Date.parse("2026-09-10T12:00:04Z"))];
  const open = { startedAt: Date.parse("2026-09-08T10:00:00Z"), draft: "口腔溃疡从八号开始，还没好。", points: "" };
  const raw = await ask(PROMPT_A_SYSTEM, buildPromptAUser({ open, dropped, clock }), 0.2);
  const decision = parseDecisionA(raw);
  assert.ok(decision, raw);
  assert.equal(decision.decision, "ignore");
  const plan = planDecisionA({ decision, dropped, open, clock });
  assert.equal(plan.open, "keep");
  assert.equal(plan.closed, null);
});

test("live A merges a continuation of the same ulcer", { skip: !hasKey, timeout: 30_000 }, async () => {
  const dropped = [
    msg("u1", "user", "还是有点疼，晚上少吃点辣。", Date.parse("2026-09-09T21:00:00Z")),
    msg("a1", "assistant", "好，今晚清淡一点。", Date.parse("2026-09-09T21:00:06Z")),
  ];
  const open = { startedAt: Date.parse("2026-09-08T10:00:00Z"), draft: "口腔溃疡从八号开始。", points: "" };
  const raw = await ask(PROMPT_A_SYSTEM, buildPromptAUser({ open, dropped, clock }), 0.2);
  const decision = parseDecisionA(raw);
  assert.ok(decision, raw);
  assert.equal(decision.decision, "merge");
  const plan = planDecisionA({ decision, dropped, open, clock });
  assert.equal(plan.closed, null);
  assert.notEqual(plan.open, "keep");
  assert.match((plan.open as { draft: string }).draft, /溃疡|疼|辣/);
});

test("live A closes the ulcer when the talk turns to moving", { skip: !hasKey, timeout: 30_000 }, async () => {
  const dropped = [
    msg("u0", "user", "溃疡不疼了，这事算过了。", Date.parse("2026-09-10T17:50:00Z")),
    msg("a0", "assistant", "好，那这块就放下。", Date.parse("2026-09-10T17:50:06Z")),
    msg("u1", "user", "另外，搬家的箱子你帮我看一下。林泽那边钥匙也要收，别混进纸箱。", Date.parse("2026-09-10T18:00:00Z")),
    msg("a1", "assistant", "箱子我来封。钥匙单独放。", Date.parse("2026-09-10T18:00:08Z")),
  ];
  const open = {
    startedAt: Date.parse("2026-09-08T10:00:00Z"),
    draft: "口腔溃疡从八号开始，九号还在疼。",
    points: "八号起，九号少吃辣。",
  };
  const raw = await ask(PROMPT_A_SYSTEM, buildPromptAUser({ open, dropped, clock }), 0.2);
  const decision = parseDecisionA(raw);
  assert.ok(decision, raw);
  assert.equal(decision.decision, "close_and_open");
  const plan = planDecisionA({ decision, dropped, open, clock });
  assert.ok(plan.closed?.text);
  assert.match(plan.closed?.text ?? "", /溃疡/);
  assert.notEqual(plan.open, "keep");
  assert.match((plan.open as { draft: string }).draft, /搬家|箱子|林泽|钥匙/);
});

test("live B collapses two finished events on the same thread", { skip: !hasKey, timeout: 30_000 }, async () => {
  const raw = await ask(
    PROMPT_B_SYSTEM,
    buildPromptBUser({
      periodStart: "2026年9月8日",
      periodEnd: "2026年9月10日",
      l1: [
        { startedAt: Date.parse("2026-09-08T10:00:00Z"), endedAt: Date.parse("2026-09-10T12:00:00Z"), text: "口腔溃疡从八号疼到十号，少吃辣之后结痂。" },
        { startedAt: Date.parse("2026-09-10T18:00:00Z"), endedAt: Date.parse("2026-09-10T20:00:00Z"), text: "开始收拾搬家箱子，林泽的钥匙要单独放。" },
      ],
      clock,
    }),
    0.3,
  );
  const list = parseL2List(raw);
  assert.ok(list, raw);
  assert.ok(list.length >= 1);
  assert.ok(list.length <= 3);
  const joined = list.map((item) => item.text).join("\n");
  assert.match(joined, /溃疡|搬家|林泽/);
});

test("live C rewrites portrait and can mark a pattern dormant", { skip: !hasKey, timeout: 30_000 }, async () => {
  const raw = await ask(
    PROMPT_C_SYSTEM,
    buildPromptCUser({
      periodStart: "2026年9月8日",
      periodEnd: "2026年9月10日",
      newL2: [{ time: "9月8日-10日", text: "口腔溃疡好了。开始收拾搬家，林泽的钥匙要单独放。" }],
      oldL2: [],
      oldL3: [
        {
          id: "p1",
          status: "active",
          text: "近期容易反复口腔溃疡。",
          lastEvidenceAt: Date.parse("2026-08-01T00:00:00Z"),
          createdAt: Date.parse("2026-08-01T00:00:00Z"),
          updatedAt: Date.parse("2026-08-01T00:00:00Z"),
        },
      ],
      portrait: "最近身体有点紧，说话少。",
      openDraft: "箱子还没封完。",
      now: Date.parse("2026-09-10T20:00:00Z"),
      clock,
    }),
    0.4,
  );
  const parsed = parsePatternsAndPortrait(raw);
  assert.ok(parsed, raw);
  assert.ok(parsed.portrait.trim().length > 10);
  assert.doesNotMatch(parsed.portrait, /清然应该/);
  assert.ok(parsed.patterns.some((item) => /溃疡/.test(item.text)));
});
