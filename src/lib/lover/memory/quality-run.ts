import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { planDecisionA } from "./apply.ts";
import { formatClock } from "../prompt.ts";
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
  { at: "2026-09-08 19:02", role: "user", text: "在吗" },
  { at: "2026-09-08 19:02", role: "assistant", text: "在。" },
  { at: "2026-09-08 19:04", role: "user", text: "口腔溃疡又起来了，上火，说话都刺。" },
  { at: "2026-09-08 19:04", role: "assistant", text: "今天少吃辣，别用舌尖去碰。" },
  { at: "2026-09-08 19:06", role: "user", text: "吃饭了吗" },
  { at: "2026-09-08 19:06", role: "assistant", text: "吃了。你呢。" },
  { at: "2026-09-08 19:07", role: "user", text: "喝了点粥。课排到晚上，好累。" },
  { at: "2026-09-08 19:07", role: "assistant", text: "先把粥喝完。溃疡这几天会烦。" },
  { at: "2026-09-08 19:18", role: "user", text: "林泽下午来拿东西，没多说话，钥匙还在他那儿。" },
  { at: "2026-09-08 19:18", role: "assistant", text: "钥匙回头单独放。今天先别管他。" },
  { at: "2026-09-08 19:22", role: "user", text: "嗯。" },
  { at: "2026-09-08 19:22", role: "assistant", text: "我在。" },
  { at: "2026-09-08 22:40", role: "user", text: "还是疼。想睡觉又睡不着。" },
  { at: "2026-09-08 22:40", role: "assistant", text: "别熬。明天实验室可以晚一点到。" },
  { at: "2026-09-08 22:43", role: "user", text: "晚安。" },
  { at: "2026-09-08 22:43", role: "assistant", text: "晚安。" },

  { at: "2026-09-09 08:11", role: "user", text: "早。溃疡没消，刷牙都小心。" },
  { at: "2026-09-09 08:11", role: "assistant", text: "盐水漱，别用力。" },
  { at: "2026-09-09 12:40", role: "user", text: "中午没忍住，吃了麻辣烫，现在整片都肿了。" },
  { at: "2026-09-09 12:40", role: "assistant", text: "今天剩下都清淡。冰的也不要。" },
  { at: "2026-09-09 12:42", role: "user", text: "好的。" },
  { at: "2026-09-09 12:42", role: "assistant", text: "嗯。" },
  { at: "2026-09-09 21:05", role: "user", text: "实验课到九点。林泽说这周末把剩下的箱子清走。" },
  { at: "2026-09-09 21:05", role: "assistant", text: "箱子我可以跟你一起看。钥匙别混进纸箱。" },
  { at: "2026-09-09 21:08", role: "user", text: "天气好热。" },
  { at: "2026-09-09 21:08", role: "assistant", text: "回来先喝水。" },
  { at: "2026-09-09 23:10", role: "user", text: "晚安。" },
  { at: "2026-09-09 23:10", role: "assistant", text: "晚安。溃疡会过的。" },

  { at: "2026-09-10 10:20", role: "user", text: "溃疡结痂了，不太疼了。这事算过了。" },
  { at: "2026-09-10 10:20", role: "assistant", text: "好，那这块放下。" },
  { at: "2026-09-10 18:03", role: "user", text: "另外，搬家的箱子你帮我看一下。林泽那边钥匙也要收，别混进纸箱。" },
  { at: "2026-09-10 18:03", role: "assistant", text: "箱子我来封。钥匙单独放。" },
  { at: "2026-09-10 18:12", role: "user", text: "翻到一张合照，不知道怎么办。丢掉也奇怪。" },
  { at: "2026-09-10 18:12", role: "assistant", text: "先收起来。不是今天必须决定的。" },
  { at: "2026-09-10 18:16", role: "user", text: "先夹进书里吧。" },
  { at: "2026-09-10 18:16", role: "assistant", text: "好。" },
  { at: "2026-09-10 18:20", role: "user", text: "在吗" },
  { at: "2026-09-10 18:20", role: "assistant", text: "在。" },
  { at: "2026-09-10 22:01", role: "user", text: "封了三个箱子。好累。" },
  { at: "2026-09-10 22:01", role: "assistant", text: "够了。剩下明天。" },

  { at: "2026-09-11 09:14", role: "user", text: "钥匙单独放好了。箱子也封完了。" },
  { at: "2026-09-11 09:14", role: "assistant", text: "好。林泽来拿的时候你不用自己扛。" },
  { at: "2026-09-11 09:16", role: "user", text: "今天值班。" },
  { at: "2026-09-11 09:16", role: "assistant", text: "中午记得吃饭。" },
  { at: "2026-09-11 12:30", role: "user", text: "吃了。" },
  { at: "2026-09-11 12:30", role: "assistant", text: "好。" },
  { at: "2026-09-11 20:40", role: "user", text: "值班完了。没事，就是乏。" },
  { at: "2026-09-11 20:40", role: "assistant", text: "早点睡。" },
  { at: "2026-09-11 21:05", role: "user", text: "合照还在书里。先这样。" },
  { at: "2026-09-11 21:05", role: "assistant", text: "先这样。" },
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
    chat: "# 聊天记录\n\n样例四天对话，用来看 L1 写得够不够高。\n",
    l1: "# L1 已结束事件\n\n",
    l2: "# L2 收束叙述\n\n",
    l3: "# L3 规律快照\n\n",
    portrait: "# 活画像历史\n\n",
    open: "# 未闭合事件草稿\n\n",
    process: "# A/B/C 工作过程\n\n",
  };

  const messages: ChatMessage[] = [];
  let open: OpenEvent | null = null;
  const l1: Array<{ startedAt: number; endedAt: number; text: string; createdAt: number }> = [];
  const l2: L2Event[] = [];
  let l3: L3Pattern[] = [];
  let portrait = "";
  let lastIntervalDay = "";
  let lastL1Count = 0;

  const write = (name: keyof typeof files, at: number, body: string) => {
    files[name] += block(at, body);
  };

  for (const turn of TURNS) {
    const createdAt = ny(turn.at);
    const msg: ChatMessage = {
      id: `m-${messages.length + 1}`,
      role: turn.role,
      text: turn.text,
      createdAt,
    };
    messages.push(msg);
    write("chat", createdAt, `${turn.role === "user" ? "Rosie" : "清然"}：${turn.text}`);

    const overflowAt = Math.max(0, messages.length - CONTEXT_WINDOW);
    const dropped = messages.slice(0, overflowAt).filter((m) => !m.scanned);
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(createdAt));
    const isLastOfDay =
      TURNS[TURNS.indexOf(turn) + 1] === undefined ||
      new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(ny(TURNS[TURNS.indexOf(turn) + 1]!.at))) !==
        day;
    if (dropped.length && (dropped.length >= 6 || isLastOfDay)) {
      const raw = await ask(PROMPT_A_SYSTEM, buildPromptAUser({ open, dropped, clock }), 0.2, 800);
      const decision = parseDecisionA(raw);
      if (!decision) {
        write("process", createdAt, `步骤 A\n判定 parse_fail\n${raw}`);
      } else {
        const plan = planDecisionA({ decision, dropped, open, clock, now: createdAt });
        for (const id of plan.scannedIds) {
          const row = messages.find((m) => m.id === id);
          if (row) row.scanned = true;
        }
        if (plan.closed) {
          l1.push({ ...plan.closed, createdAt });
          write(
            "l1",
            createdAt,
            `L1 ${clock(plan.closed.startedAt)} → ${clock(plan.closed.endedAt)}\n${plan.closed.text}`,
          );
        }
        if (plan.open !== "keep") {
          open = plan.open;
          write(
            "open",
            createdAt,
            open ? `未闭合事件\n开始：${clock(open.startedAt)}\n草稿：${open.draft}` : "未闭合事件：已清空",
          );
        }
        write(
          "process",
          createdAt,
          `步骤 A\n判定 ${plan.logKind}\n备注 ${plan.note || "（无）"}\n${plan.closed ? `收入 L1：${plan.closed.text}\n` : ""}${plan.open === "keep" ? "" : `当前草稿：${plan.open?.draft ?? "（空）"}\n`}\n模型原文\n${raw}`,
        );
      }
    }

    if (!isLastOfDay || lastIntervalDay === day) continue;

    const newL1 = l1.slice(lastL1Count);
    lastL1Count = l1.length;
    lastIntervalDay = day;
    const periodStart = clock(ny(`${day} 00:00`));
    const periodEnd = clock(createdAt);

    if (newL1.length) {
      const rawB = await ask(
        PROMPT_B_SYSTEM,
        buildPromptBUser({
          periodStart,
          periodEnd,
          l1: newL1,
          clock,
        }),
        0.3,
        1200,
      );
      const list = parseL2List(rawB) ?? [];
      for (const item of list) {
        const row: L2Event = {
          id: `l2-${l2.length + 1}`,
          periodStart: ny(`${day} 00:00`),
          periodEnd: createdAt,
          text: item.text,
          createdAt,
        };
        l2.push(row);
        write("l2", createdAt, `L2 ${item.time || day}\n${item.text}`);
      }
      write("process", createdAt, `步骤 B\n备注 ${list.length} 条 L2\n\n模型原文\n${rawB}`);
    } else {
      write("process", createdAt, `步骤 B\n本日没有新的 L1，跳过收束。`);
    }

    const newL2 = l2.filter((item) => item.createdAt === createdAt).map((item) => ({ time: day, text: item.text }));
    if (!newL2.length && !l2.length && !l3.length && !portrait) continue;
    const rawC = await ask(
      PROMPT_C_SYSTEM,
      buildPromptCUser({
        periodStart,
        periodEnd,
        newL2,
        oldL2: l2,
        oldL3: l3,
        portrait,
        openDraft: open?.draft ?? "",
        now: createdAt,
        clock,
      }),
      0.4,
      2000,
    );
    const parsed = parsePatternsAndPortrait(rawC);
    if (!parsed) {
      write("process", createdAt, `步骤 C\n判定 parse_fail\n${rawC}`);
      continue;
    }
    if (parsed.portrait.trim()) {
      portrait = parsed.portrait.trim();
      write("portrait", createdAt, `活画像\n${portrait}`);
    }
    if (parsed.patterns.length) {
      l3 = parsed.patterns.map((item, i) => ({
        id: `p-${i + 1}`,
        status: item.status,
        text: item.text,
        lastEvidenceAt: createdAt,
        createdAt,
        updatedAt: createdAt,
      }));
      write(
        "l3",
        createdAt,
        `规律快照\n${l3.map((item) => `- [${item.status}] ${item.text}`).join("\n")}`,
      );
    }
    write("process", createdAt, `步骤 C\n备注 规律 ${parsed.patterns.length} 条\n\n模型原文\n${rawC}`);
  }

  const summary = `# 样例跑完摘要

近窗 ${CONTEXT_WINDOW} 条。对话 ${messages.length} 条。L1 ${l1.length} 条，L2 ${l2.length} 条，规律 ${l3.length} 条。

## 最终未闭合草稿
${open ? open.draft : "（空）"}

## 最终 L1
${l1.length ? l1.map((item, i) => `${i + 1}. ${item.text}`).join("\n") : "（无）"}

## 最终 L2
${l2.length ? l2.map((item, i) => `${i + 1}. ${item.text}`).join("\n") : "（无）"}

## 最终规律
${l3.length ? l3.map((item) => `- [${item.status}] ${item.text}`).join("\n") : "（无）"}

## 最终画像
${portrait || "（无）"}
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
