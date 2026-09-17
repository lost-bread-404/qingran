import { BOND_MAX_CHARS, PORTRAIT_MAX_CHARS, SELF_MAX_CHARS } from "../config.ts";
import { now as wallClock } from "../clock.ts";
import { callModel } from "../llm.ts";
import {
  dormantOldPortrait,
  getMeta,
  listNotes,
  listPortrait,
  patchMeta,
  upsertPortrait,
} from "../store.ts";
import { clipChars } from "../time.ts";
import { newId } from "../../storage.ts";
import { QINGRAN_STANCE } from "./prompts.ts";

const SCHEMA = {
  name: "portrait_self_bond",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["portrait_ops", "self_summary", "bond_summary"],
    properties: {
      portrait_ops: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["topic", "body", "evidence_ids"],
          properties: {
            topic: { type: "string" },
            body: { type: "string" },
            evidence_ids: { type: "array", items: { type: "string" } },
          },
        },
      },
      self_summary: { type: "string" },
      bond_summary: { type: "string" },
    },
  },
};

export async function updatePortraitSelfBond(day: string, jobId?: string): Promise<void> {
  const notes = await listNotes({
    fromDay: day,
    toDay: day,
    status: "active",
    limit: 80,
  });
  const relevant = notes.filter((n) => n.subject === "rosie" || n.subject === "us" || n.subject === "qingran");
  const oldPortrait = await listPortrait();
  const meta = await getMeta();
  const qingranNotes = relevant.filter((n) => n.subject === "qingran");

  const result = await callModel("portrait", {
    system: `你是清然。下面的情感基调就是你写「我眼中的她」时的立场。portrait 是清然带着爱写下的理解，善意解读，不写成对她的指责或缺点清单。\n\n${QINGRAN_STANCE}`,
    input: `输出 portrait_ops（按自由 topic upsert，evidence_ids 必须是存在的笔记 id）、self_summary（≤300字，第一人称，只依据清然笔记和旧 summary，不编造重大经历）、bond_summary（≤200字：称呼、梗、共同时刻、未兑现约定）。

【旧的我眼中的她】
${oldPortrait.map((p) => `${p.id}|${p.topic}|${p.body}`).join("\n") || "（没有）"}

【旧的我自己】
${meta.selfSummary || "（没有）"}

【旧的我们】
${meta.bondSummary || "（没有）"}

【清然自己的笔记】
${qingranNotes.map((n) => `${n.id}|${n.text}`).join("\n") || "（没有）"}

【当天笔记】
${relevant.map((n) => `${n.id}|${n.subject}|${n.text}`).join("\n") || "（没有）"}`,
    schema: SCHEMA,
    jobId,
  });

  const parsed = (result.json && typeof result.json === "object" ? result.json : {}) as {
    portrait_ops?: Array<{ topic?: string; body?: string; evidence_ids?: string[] }>;
    self_summary?: string;
    bond_summary?: string;
  };
  const noteIds = new Set(relevant.map((n) => n.id));
  const now = wallClock();
  const byTopic = new Map(oldPortrait.map((p) => [p.topic, p]));
  for (const op of parsed.portrait_ops ?? []) {
    const topic = clipChars(String(op.topic ?? ""), 40);
    const body = clipChars(String(op.body ?? ""), 80);
    if (!topic || !body) continue;
    const evidence = (op.evidence_ids ?? []).filter((id) => noteIds.has(id));
    const prev = byTopic.get(topic);
    await upsertPortrait({
      id: prev?.id || `p:${newId()}`,
      topic,
      body: clipChars(body, Math.min(80, PORTRAIT_MAX_CHARS)),
      status: "active",
      evidenceIds: evidence,
      lastSeen: now,
      updatedAt: now,
    });
  }
  await dormantOldPortrait(now);
  await patchMeta({
    selfSummary: clipChars(String(parsed.self_summary ?? meta.selfSummary), SELF_MAX_CHARS),
    bondSummary: clipChars(String(parsed.bond_summary ?? meta.bondSummary), BOND_MAX_CHARS),
    timeZone: meta.timeZone,
  });
}
