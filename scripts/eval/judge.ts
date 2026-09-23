/**
 * LLM-as-judge for 清然侧（route `judge`，模型由 brain/config.ts 决定）。
 * 不依赖数据库，可以直接用 node 运行：
 *
 *   XAI_API_KEY=... node --experimental-strip-types scripts/eval/judge.ts transcript.json [charter.txt]
 *
 * transcript.json: [{ "role": "user" | "assistant", "text": "...", "createdAt"?: number }, ...]
 * 对每一条 assistant 回复打分，输出 markdown 汇总到 stdout。
 */
import { readFileSync } from "node:fs";
import { resolveRoute } from "../../src/lib/lover/brain/config.ts";
import { defaultDoc, renderVariant, type PromptDoc } from "../../src/lib/lover/brain/prompts/doc.ts";

export type QingranScores = {
  followed_up: 0 | 1;
  used_memory_correctly: 0 | 1;
  memory_hallucination: 0 | 1;
  expressed_own_view: 0 | 1;
  repeated_phrase: 0 | 1;
  handed_back: 0 | 1;
  felt_seen: number;
  logic: number;
  agency: number;
  persona_fit: number;
  takes_lead: number;
  devotion: number;
  warmth: number;
};

const BINARY = [
  "followed_up",
  "used_memory_correctly",
  "memory_hallucination",
  "expressed_own_view",
  "repeated_phrase",
  "handed_back",
] as const;

const SCALE = [
  "felt_seen",
  "logic",
  "agency",
  "persona_fit",
  "takes_lead",
  "devotion",
  "warmth",
] as const;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [...BINARY, ...SCALE, "reason"],
  properties: {
    ...Object.fromEntries(BINARY.map((k) => [k, { type: "integer", enum: [0, 1] }])),
    ...Object.fromEntries(SCALE.map((k) => [k, { type: "integer", minimum: 1, maximum: 5 }])),
    reason: { type: "string" },
  },
};

type Turn = { role: "user" | "assistant"; text: string; createdAt?: number };

function outputText(raw: unknown): string {
  const body = raw as {
    output_text?: string;
    output?: Array<{ type?: string; content?: Array<{ text?: string }> }>;
  };
  if (body?.output_text) return body.output_text;
  return (body?.output ?? [])
    .filter((o) => o.type === "message")
    .flatMap((o) => o.content ?? [])
    .map((c) => c.text ?? "")
    .join("");
}

async function judgeDoc(): Promise<PromptDoc> {
  try {
    const { loadPrompt } = await import("../../src/lib/lover/brain/prompts/store.ts");
    return (await loadPrompt("judge")).doc;
  } catch {
    return defaultDoc("judge");
  }
}

export async function judgeQingran(args: {
  charter: string;
  transcript: string;
}): Promise<QingranScores & { reason: string }> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error("XAI_API_KEY is required");
  const r = resolveRoute("judge");
  const messages = renderVariant(await judgeDoc(), "main", {
    charter: args.charter,
    transcript: args.transcript,
  });
  const body: Record<string, unknown> = {
    model: r.model,
    input: messages,
    max_output_tokens: r.maxOutput,
    text: { format: { type: "json_schema", name: "judge", schema: SCHEMA, strict: true } },
  };
  if (r.effort) body.reasoning = { effort: r.effort };
  const res = await fetch("https://api.x.ai/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(r.timeoutMs),
  });
  if (!res.ok) throw new Error(`judge http ${res.status}: ${await res.text()}`);
  return JSON.parse(outputText(await res.json())) as QingranScores & { reason: string };
}

export async function judgeTranscript(turns: Turn[], charter: string) {
  const rows: Array<QingranScores & { reason: string; index: number }> = [];
  for (let i = 0; i < turns.length; i++) {
    if (turns[i]!.role !== "assistant") continue;
    const window = turns.slice(Math.max(0, i - 30), i + 1);
    const transcript = window
      .map((t) => `${t.role === "user" ? "Rosie" : "清然"}：${t.text}`)
      .join("\n");
    rows.push({ index: i, ...(await judgeQingran({ charter, transcript })) });
  }
  const mean = (k: keyof QingranScores) =>
    rows.length ? rows.reduce((a, r) => a + Number(r[k]), 0) / rows.length : 0;
  const lines = [
    `# 清然侧评分（${rows.length} 条回复，judge=${resolveRoute("judge").model}）`,
    "",
    "| 指标 | 均值 |",
    "|---|---|",
    ...[...BINARY, ...SCALE].map((k) => `| ${k} | ${mean(k).toFixed(2)} |`),
    "",
    "## 逐条",
    ...rows.map(
      (r) =>
        `- #${r.index} felt_seen=${r.felt_seen} logic=${r.logic} lead=${r.takes_lead} handed_back=${r.handed_back}：${r.reason}`,
    ),
  ];
  return { rows, markdown: lines.join("\n") };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [transcriptPath, charterPath] = process.argv.slice(2);
  if (!transcriptPath) {
    console.error("usage: judge.ts transcript.json [charter.txt]");
    process.exit(1);
  }
  const turns = JSON.parse(readFileSync(transcriptPath, "utf8")) as Turn[];
  const charter = charterPath ? readFileSync(charterPath, "utf8") : "你就是清然。";
  judgeTranscript(turns, charter).then(
    (r) => console.log(r.markdown),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
