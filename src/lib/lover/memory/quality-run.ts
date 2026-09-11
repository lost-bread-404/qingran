import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { planArchive } from "./apply.ts";
import { formatClock } from "../prompt.ts";
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
import { CONTEXT_WINDOW } from "./types.ts";
import type { ChatMessage } from "../types.ts";
import type { L2Event, L3Pattern, OpenEvent } from "./types.ts";

const TZ = "America/New_York";
const MODEL = "grok-4.20-0309-non-reasoning";
const OUT = join(process.cwd(), "memory-journal", "sample");

function ny(local: string): number {
  return Date.parse(`${local.replace(" ", "T")}-04:00`);
}

function clock(ms: number): string {
  return `${formatClock(ms, TZ)}  (${new Date(ms).toISOString()})`;
}

function block(at: number, body: string): string {
  return `\n---\n时间 ${clock(at)}\n${body.trim()}\n`;
}

const TURNS: Array<{ at: string; role: "user" | "assistant"; text: string }> = [
  { at: "2026-09-08 19:04", role: "user", text: "口腔溃疡又起来了，上火，说话都刺。" },
  { at: "2026-09-08 19:04", role: "assistant", text: "今天少吃辣。" },
  { at: "2026-09-08 19:18", role: "user", text: "林泽下午来拿东西，钥匙还在他那儿。" },
  { at: "2026-09-08 19:18", role: "assistant", text: "钥匙回头单独放。" },
  { at: "2026-09-10 10:20", role: "user", text: "溃疡不疼了。姐姐，你真好～" },
  { at: "2026-09-10 10:20", role: "assistant", text: "那就好。" },
  { at: "2026-09-10 18:03", role: "user", text: "搬家的箱子你帮我看一下。" },
  { at: "2026-09-10 18:03", role: "assistant", text: "箱子我来封。" },
];

async function ask(system: string, user: string, temperature: number, maxTokens: number): Promise<string> {
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
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`xai-${res.status}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = body.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) throw new Error("empty");
  return text;
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const files = {
    chat: "# 聊天记录\n",
    l1: "# L1\n",
    l2: "# L2\n",
    l3: "# L3\n",
    portrait: "# 画像\n",
    open: "# 未完成\n",
    process: "# 过程\n",
  };
  const messages: ChatMessage[] = [];
  let open: OpenEvent[] = [];
  const l1: Array<{ startedAt: number; endedAt: number; text: string }> = [];
  const l2: L2Event[] = [];
  let l3: L3Pattern[] = [];
  let portrait = "";

  const write = (name: keyof typeof files, at: number, body: string) => {
    files[name] += block(at, body);
  };

  for (const turn of TURNS) {
    const createdAt = ny(turn.at);
    messages.push({
      id: `m-${messages.length + 1}`,
      role: turn.role,
      text: turn.text,
      createdAt,
    });
    write("chat", createdAt, `${turn.role === "user" ? "Rosie" : "清然"}：${turn.text}`);
  }

  const overflowAt = Math.max(0, messages.length - CONTEXT_WINDOW);
  const dropped = overflowAt ? messages.slice(0, overflowAt) : messages;
  const now = dropped.at(-1)?.createdAt || Date.now();
  const rawA = await ask(PROMPT_A_SYSTEM, buildPromptAUser({ open, dropped, clock }), 0.2, 800);
  const archive = parseArchiveA(rawA);
  if (archive) {
    const plan = planArchive({ archive, dropped, now });
    open = plan.open.map((item) => ({ ...item, id: item.id || `o-${open.length + 1}` }));
    for (const fact of plan.facts) {
      l1.push(fact);
      write("l1", now, fact.text);
    }
    write("open", now, open.map((item) => item.text).join("\n") || "（空）");
    write("process", now, `步骤 A\n${rawA}`);
  }

  if (l1.length) {
    const rawB = await ask(
      PROMPT_B_SYSTEM,
      buildPromptBUser({
        periodStart: clock(l1[0]!.startedAt),
        periodEnd: clock(now),
        l1,
        oldL2: l2,
        clock,
      }),
      0.3,
      1200,
    );
    const list = parseL2List(rawB) ?? [];
    for (const item of list) {
      l2.push({
        id: item.id || `l2-${l2.length + 1}`,
        periodStart: now,
        periodEnd: now,
        text: item.text,
        createdAt: now,
      });
      write("l2", now, item.text);
    }
    write("process", now, `步骤 B\n${rawB}`);
  }

  const rawC = await ask(
    PROMPT_C_SYSTEM,
    buildPromptCUser({
      periodStart: clock(now),
      periodEnd: clock(now),
      newL2: l2.map((item) => ({ id: item.id, time: "本周期", text: item.text })),
      oldL2: l2,
      oldL3: l3,
      portrait,
      openDraft: open.map((item) => item.text).join("；"),
      now,
      clock,
    }),
    0.4,
    2000,
  );
  const parsed = parsePatternsAndPortrait(rawC);
  if (parsed) {
    portrait = parsed.portrait;
    l3 = parsed.patterns.map((item, i) => ({
      id: item.id || `p-${i + 1}`,
      status: item.status,
      text: item.text,
      lastEvidenceAt: now,
      createdAt: now,
      updatedAt: now,
    }));
    write("portrait", now, portrait);
    write("l3", now, l3.map((item) => `- [${item.status}] ${item.text}`).join("\n"));
    write("process", now, `步骤 C\n${rawC}`);
  }

  const summary = `# 样例摘要

L1:\n${l1.map((item) => `- ${item.text}`).join("\n") || "（无）"}

未完成:\n${open.map((item) => `- ${item.text}`).join("\n") || "（无）"}

L2:\n${l2.map((item) => `- ${item.text}`).join("\n") || "（无）"}

规律:\n${l3.map((item) => `- ${item.text}`).join("\n") || "（无）"}

画像:\n${portrait || "（无）"}
`;
  await Promise.all([
    writeFile(join(OUT, "README.md"), summary, "utf8"),
    writeFile(join(OUT, "chat.md"), files.chat, "utf8"),
    writeFile(join(OUT, "l1.md"), files.l1, "utf8"),
    writeFile(join(OUT, "l2.md"), files.l2, "utf8"),
    writeFile(join(OUT, "l3.md"), files.l3, "utf8"),
    writeFile(join(OUT, "portrait.md"), files.portrait, "utf8"),
    writeFile(join(OUT, "open.md"), files.open, "utf8"),
    writeFile(join(OUT, "process.md"), files.process, "utf8"),
  ]);
  console.log(summary);
}

await main();
