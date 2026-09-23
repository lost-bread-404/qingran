import { BOND_MAX_CHARS, PORTRAIT_MAX_CHARS, SELF_MAX_CHARS } from "../config.ts";
import { now as wallClock } from "../clock.ts";
import { callModel, asModelInput } from "../llm.ts";
import {
  dormantOldPortrait,
  getMeta,
  getProfilePrompt,
  listNotes,
  listPortrait,
  patchMeta,
  upsertPortrait,
} from "../store.ts";
import { clipChars } from "../time.ts";
import { newId } from "../../storage.ts";
import { similar } from "../text.ts";
import { isQingranBehaviorRecap, DROP_PORTRAIT_TOPICS } from "../memory-hygiene.ts";
import { renderVariant, parsePromptBody } from "../prompts/doc.ts";
import { loadPrompt } from "../prompts/store.ts";

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

export function portraitVars(input: {
  charter: string;
  oldPortrait: Array<{ id: string; topic: string; body: string }>;
  selfSummary: string;
  bondSummary: string;
  qingranNotes: Array<{ id: string; text: string }>;
  rosieNotes: Array<{ id: string; subject: string; text: string }>;
}): Record<string, string> {
  return {
    system_prompt: input.charter,
    old_portrait: input.oldPortrait.map((p) => `${p.id}|${p.topic}|${p.body}`).join("\n") || "（没有）",
    old_self: input.selfSummary || "（没有）",
    old_bond: input.bondSummary || "（没有）",
    qingran_notes: input.qingranNotes.map((n) => `${n.id}|${n.text}`).join("\n") || "（没有）",
    rosie_notes: input.rosieNotes.map((n) => `${n.id}|${n.subject}|${n.text}`).join("\n") || "（没有）",
  };
}

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
  const rosieNotes = relevant.filter((n) => n.subject === "rosie" || (n.subject === "us" && n.fromRosie));
  const loaded = await loadPrompt("portrait");
  const charter = await getProfilePrompt();
  const messages = renderVariant(
    parsePromptBody("portrait", loaded.body),
    "main",
    portraitVars({
      charter,
      oldPortrait,
      selfSummary: meta.selfSummary,
      bondSummary: meta.bondSummary,
      qingranNotes,
      rosieNotes,
    }),
  );

  const result = await callModel("portrait", {
    ...asModelInput(messages),
    schema: SCHEMA,
    jobId,
    promptKey: loaded.key,
    promptHash: loaded.hash,
  });

  const parsed = (result.json && typeof result.json === "object" ? result.json : {}) as {
    portrait_ops?: Array<{ topic?: string; body?: string; evidence_ids?: string[] }>;
    self_summary?: string;
    bond_summary?: string;
  };
  const noteIds = new Set([...relevant.map((n) => n.id), ...rosieNotes.map((n) => n.id)]);
  const now = wallClock();
  const byTopic = new Map(oldPortrait.map((p) => [p.topic, p]));
  for (const op of parsed.portrait_ops ?? []) {
    const topic = clipChars(String(op.topic ?? ""), 40);
    const body = clipChars(String(op.body ?? ""), 80);
    if (!topic || !body) continue;
    if (DROP_PORTRAIT_TOPICS.includes(topic)) continue;
    if (isQingranBehaviorRecap(`${topic}${body}`)) continue;
    const evidence = (op.evidence_ids ?? []).filter((id) => noteIds.has(id));
    const prev =
      byTopic.get(topic) ||
      oldPortrait.find((p) => similar(p.topic, topic) || similar(p.body, body));
    if (prev && DROP_PORTRAIT_TOPICS.includes(prev.topic)) continue;
    await upsertPortrait({
      id: prev?.id || `p:${newId()}`,
      topic: prev?.topic || topic,
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
