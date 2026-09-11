import assert from "node:assert/strict";
import { test } from "node:test";
import { planArchive } from "./apply.ts";
import {
  PROMPT_A_SYSTEM,
  PROMPT_B_SYSTEM,
  PROMPT_C_SYSTEM,
  buildPromptAUser,
  buildPromptBUser,
  buildPromptCUser,
  parseArchiveA,
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

test("live A keeps 撒娇 open and writes 溃疡好了 as a fact", { skip: !hasKey, timeout: 30_000 }, async () => {
  const dropped = [
    msg("u1", "user", "溃疡不疼了。姐姐，你真好～", Date.parse("2026-09-10T18:00:00Z")),
    msg("a1", "assistant", "那就好。", Date.parse("2026-09-10T18:00:06Z")),
  ];
  const open = [
    { id: "ulcer", startedAt: Date.parse("2026-09-08T10:00:00Z"), text: "Rosie口腔溃疡还没好。" },
    { id: "flirt", startedAt: Date.parse("2026-09-10T17:00:00Z"), text: "Rosie在对清然撒娇。" },
  ];
  const raw = await ask(PROMPT_A_SYSTEM, buildPromptAUser({ open, dropped, clock }), 0.2);
  const archive = parseArchiveA(raw);
  assert.ok(archive, raw);
  const plan = planArchive({ archive, dropped });
  assert.ok(plan.facts.some((item) => /溃疡/.test(item.text)));
  assert.ok(!plan.open.some((item) => /溃疡还没好/.test(item.text)));
});

test("live B updates the ulcer arc instead of splitting it", { skip: !hasKey, timeout: 30_000 }, async () => {
  const raw = await ask(
    PROMPT_B_SYSTEM,
    buildPromptBUser({
      periodStart: "2026年9月8日",
      periodEnd: "2026年9月10日",
      l1: [
        { startedAt: Date.parse("2026-09-08T10:00:00Z"), endedAt: Date.parse("2026-09-08T10:00:00Z"), text: "Rosie长了口腔溃疡。" },
        { startedAt: Date.parse("2026-09-10T18:00:00Z"), endedAt: Date.parse("2026-09-10T18:00:00Z"), text: "Rosie今天溃疡好了。" },
      ],
      oldL2: [
        {
          id: "arc-ulcer",
          periodStart: Date.parse("2026-09-08T10:00:00Z"),
          periodEnd: Date.parse("2026-09-08T12:00:00Z"),
          text: "Rosie长了口腔溃疡。",
          createdAt: Date.parse("2026-09-08T12:00:00Z"),
        },
      ],
      clock,
    }),
    0.3,
  );
  const list = parseL2List(raw);
  assert.ok(list, raw);
  assert.equal(list.length, 1);
  assert.match(list[0]?.text ?? "", /溃疡/);
  assert.match(list[0]?.id || "arc-ulcer", /arc-ulcer|/);
});

test("live C updates one ulcer pattern and writes a Rosie-only portrait", { skip: !hasKey, timeout: 30_000 }, async () => {
  const raw = await ask(
    PROMPT_C_SYSTEM,
    buildPromptCUser({
      periodStart: "2026年9月8日",
      periodEnd: "2026年9月10日",
      newL2: [{ id: "arc-ulcer", time: "9月8日-10日", text: "Rosie长了溃疡，今天好了。" }],
      oldL2: [],
      oldL3: [
        {
          id: "p-ulcer",
          status: "active",
          text: "Rosie长溃疡会告诉清然。",
          lastEvidenceAt: Date.parse("2026-08-01T00:00:00Z"),
          createdAt: Date.parse("2026-08-01T00:00:00Z"),
          updatedAt: Date.parse("2026-08-01T00:00:00Z"),
        },
      ],
      portrait: "最近身体有点紧。",
      openDraft: "Rosie在对清然撒娇。",
      now: Date.parse("2026-09-10T20:00:00Z"),
      clock,
    }),
    0.4,
  );
  const parsed = parsePatternsAndPortrait(raw);
  assert.ok(parsed, raw);
  assert.ok(parsed.portrait.trim().length > 8);
  assert.doesNotMatch(parsed.portrait, /清然继续|清然建议|清然习惯/);
  assert.ok(parsed.patterns.some((item) => /溃疡/.test(item.text)));
});
