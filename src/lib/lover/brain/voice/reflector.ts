import { QR_VOICE_READS_DIARY, REFLECT_WINDOW } from "../config.ts";
import { callModel } from "../llm.ts";
import { validateMind } from "../mind-parse.ts";
import {
  appendBrainLog,
  getMeta,
  getMind,
  getProfilePrompt,
  listFindings,
  listHistoryWindow,
  listPortrait,
  listThemes,
  listThemeWeeks,
  saveMind,
} from "../store.ts";
import { formatClock } from "../time.ts";
import type { Mind } from "../types.ts";
import { EMPTY_MIND } from "../types.ts";
import { REFLECTOR_SYSTEM } from "./prompts.ts";
import { formatIndexLine, getMemoryIndex } from "./retrieve.ts";

const MIND_SCHEMA = {
  name: "mind",
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "rosie_now",
      "undercurrent",
      "reading",
      "soft_spot",
      "my_feel",
      "my_view",
      "my_logic",
      "lead_plan",
      "intent",
      "threads",
      "memory_ids",
    ],
    properties: {
      rosie_now: { type: "string" },
      undercurrent: { type: "string" },
      reading: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["guess", "conf"],
          properties: {
            guess: { type: "string" },
            conf: { type: "number" },
          },
        },
      },
      soft_spot: { type: "string" },
      my_feel: { type: "string" },
      my_view: { type: "string" },
      my_logic: { type: "string" },
      lead_plan: { type: "array", items: { type: "string" } },
      intent: { type: "string" },
      threads: { type: "array", items: { type: "string" } },
      memory_ids: { type: "array", items: { type: "string" } },
    },
  },
};

export { validateMind } from "../mind-parse.ts";

export async function runReflector(turnSeq: number, jobId?: string): Promise<Mind | null> {
  const old = await getMind();
  if (old.turn_seq >= turnSeq) return old;

  const [meta, history, portrait, index, systemPrompt] = await Promise.all([
    getMeta(),
    listHistoryWindow(null, REFLECT_WINDOW),
    listPortrait(),
    getMemoryIndex(),
    getProfilePrompt(),
  ]);

  let diaryBlock = "";
  if (QR_VOICE_READS_DIARY) {
    const [themes, findings, weeks] = await Promise.all([
      listThemes(true),
      listFindings(),
      listThemeWeeks(),
    ]);
    const usableThemes = themes.filter((t) => t.userFeedback !== "rejected").slice(0, 8);
    const weekMap = new Map<string, string>();
    for (const w of weeks.sort((a, b) => b.week.localeCompare(a.week))) {
      if (!weekMap.has(w.themeId)) {
        weekMap.set(w.themeId, `${w.week} 提到 ${w.mentions} 次`);
      }
    }
    if (usableThemes.length) {
      diaryBlock +=
        "【她的长期规律·主题】\n" +
        usableThemes
          .map((t) => `- ${t.name}：${t.definition}（${weekMap.get(t.id) ?? "尚无周统计"}）`)
          .join("\n") +
        "\n";
    }
    const usableFindings = findings
      .filter((f) => f.userFeedback !== "rejected" && f.kind !== "cooccur")
      .slice(0, 5);
    if (usableFindings.length) {
      diaryBlock +=
        "【她的长期规律·发现】\n" +
        usableFindings
          .map(
            (f) =>
              `- ${f.kind}：${f.antecedentId} 之后 ${f.lag} 天常见 ${f.outcomeId}（${f.n11} 次，lift ${f.lift.toFixed(2)}）`,
          )
          .join("\n") +
        "\n";
    }
  }

  const portraitText = portrait
    .filter((p) => p.status === "active")
    .map((p) => `${p.topic}：${p.body}`)
    .join("\n");
  const indexText = index.items.map(formatIndexLine).join("\n");
  const convo = history
    .map((m) => `${m.role === "user" ? "Rosie" : "清然"}：${m.text}`)
    .join("\n");

  const user = `【人设】
${systemPrompt}

现在是${formatClock(Date.now(), meta.timeZone || "UTC")}。

【我自己】
${meta.selfSummary || "（还没有）"}

【我们】
${meta.bondSummary || "（还没有）"}

【我眼中的她】
${portraitText || "（还在认识她）"}

${diaryBlock}
【上一刻的内心】
${JSON.stringify({ ...old, recent_intents: old.recent_intents, turn_seq: undefined })}

【最近对话】
${convo || "（还没有）"}

【记忆 index】
${indexText || "（还没有）"}

请按 schema 输出内心。不要输出 recent_intents 和 turn_seq。`;

  const result = await callModel("reflect", {
    system: REFLECTOR_SYSTEM,
    input: user,
    schema: MIND_SCHEMA,
    jobId,
  });
  if (!result.ok || !result.json) {
    await appendBrainLog({
      jobId,
      step: "reflect:keep-old",
      ok: false,
      note: "timeout-or-parse",
    });
    return null;
  }
  const next = validateMind(result.json, old, new Set(index.items.map((i) => i.id)));
  next.turn_seq = turnSeq;
  const saved = await saveMind(next, turnSeq);
  return saved ? next : old;
}

export { EMPTY_MIND };
