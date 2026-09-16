import { callModel, type ToolDef } from "../llm.ts";
import {
  getTheme,
  listDays,
  listFactors,
  listIntentions,
  listMessagesByIds,
  listNotes,
  listThemes,
} from "../store.ts";
import { computeAllFindings, seriesFromDayFactors } from "./stats.ts";
import { listDayFactors } from "../store.ts";
import { DIARY_ANALYST_SYSTEM } from "./prompts.ts";

const TOOLS: ToolDef[] = [
  {
    type: "function",
    name: "search_notes",
    description: "搜索日记笔记（仅 diary lens，from_rosie=true）",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string" },
        from_day: { type: "string" },
        to_day: { type: "string" },
      },
      required: ["query", "from_day", "to_day"],
    },
  },
  {
    type: "function",
    name: "get_days",
    description: "读取一段日期的 day logs",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { from_day: { type: "string" }, to_day: { type: "string" } },
      required: ["from_day", "to_day"],
    },
  },
  {
    type: "function",
    name: "get_factor_series",
    description: "某个 factor 的每日 value",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        from_day: { type: "string" },
        to_day: { type: "string" },
      },
      required: ["name", "from_day", "to_day"],
    },
  },
  {
    type: "function",
    name: "compute_lift",
    description: "计算两个 factor 的 lift",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        outcome: { type: "string" },
        antecedent: { type: "string" },
        lag: { type: "integer" },
      },
      required: ["outcome", "antecedent", "lag"],
    },
  },
  {
    type: "function",
    name: "list_themes",
    description: "列出主题",
    parameters: { type: "object", additionalProperties: false, properties: {}, required: [] },
  },
  {
    type: "function",
    name: "get_theme",
    description: "读取一个主题",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    type: "function",
    name: "list_intentions",
    description: "列出 intentions",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { tag: { type: "string" }, status: { type: "string" } },
      required: ["tag", "status"],
    },
  },
  {
    type: "function",
    name: "read_messages",
    description: "按 id 读原始消息",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { ids: { type: "array", items: { type: "string" } } },
      required: ["ids"],
    },
  },
];

async function runTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === "search_notes") {
    return listNotes({
      q: String(args.query ?? ""),
      fromDay: String(args.from_day ?? "") || undefined,
      toDay: String(args.to_day ?? "") || undefined,
      fromRosie: true,
      lens: "diary",
      status: "active",
      limit: 40,
    });
  }
  if (name === "get_days") {
    return listDays(String(args.from_day ?? ""), String(args.to_day ?? ""));
  }
  if (name === "get_factor_series") {
    const factors = await listFactors(true);
    const f = factors.find((x) => x.name === args.name || x.id === args.name);
    if (!f) return [];
    const rows = await listDayFactors(String(args.from_day || "") || undefined, String(args.to_day || "") || undefined);
    return rows.filter((r) => r.factorId === f.id);
  }
  if (name === "compute_lift") {
    const factors = await listFactors(true);
    const o = factors.find((x) => x.name === args.outcome || x.id === args.outcome);
    const a = factors.find((x) => x.name === args.antecedent || x.id === args.antecedent);
    if (!o || !a) return { error: "unknown factor" };
    const rows = await listDayFactors();
    const findings = computeAllFindings({
      factors: [o, a],
      dayFactors: rows,
      themeWeeks: [],
    });
    return findings.filter((f) => f.outcomeId === o.id && f.antecedentId === a.id);
  }
  if (name === "list_themes") return listThemes(true);
  if (name === "get_theme") return getTheme(String(args.id ?? ""));
  if (name === "list_intentions") {
    return listIntentions({
      tag: String(args.tag ?? "") || undefined,
      status: String(args.status ?? "") || undefined,
    });
  }
  if (name === "read_messages") {
    const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
    return listMessagesByIds(ids);
  }
  return { error: "unknown tool" };
}

export async function askDiary(question: string): Promise<{ text: string; ok: boolean }> {
  const previous: unknown[] = [];
  for (let i = 0; i < 8; i++) {
    const result = await callModel("ask", {
      system: `${DIARY_ANALYST_SYSTEM}
回答必须附证据（日期或 note id）；数字必须来自 tool 结果；不确定时说明数据不足。`,
      input: question,
      tools: TOOLS,
      previous,
    });
    if (result.toolCalls.length) {
      for (const call of result.toolCalls) {
        const output = await runTool(call.name, call.arguments);
        previous.push({
          type: "function_call",
          call_id: call.callId,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        });
        previous.push({
          type: "function_call_output",
          call_id: call.callId,
          output: JSON.stringify(output).slice(0, 8000),
        });
      }
      continue;
    }
    if (result.text.trim()) return { text: result.text.trim(), ok: true };
    break;
  }

  const notes = await listNotes({ q: question, fromRosie: true, lens: "diary", status: "active", limit: 20 });
  const days = await listDays("2000-01-01", "2100-01-01");
  const fallback = await callModel("ask", {
    system: `${DIARY_ANALYST_SYSTEM}
没有 function calling。只用下面检索到的材料回答。没有数字就说数据不足。`,
    input: `问题：${question}

笔记：
${notes.map((n) => `${n.localDay} ${n.id} ${n.text}`).join("\n")}

最近 day logs：
${days.slice(-14).map((d) => `${d.day} e=${d.energy} m=${d.mood} ${d.summary}`).join("\n")}`,
  });
  return { text: fallback.text.trim() || "数据不足，我还没法回答这个。", ok: fallback.ok };
}
