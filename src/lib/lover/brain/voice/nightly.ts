import { BOND_MAX_CHARS, SELF_MAX_CHARS } from "../config.ts";
import { now as wallClock } from "../clock.ts";
import { callModel, asModelInput } from "../llm.ts";
import { isNightNoiseBody, modelFacingText } from "../../message-markup.ts";
import {
  getMeta,
  getProfileData,
  getProfilePrompt,
  listNotes,
  listNotesByIds,
  listPortrait,
  listRecentMessages,
  patchMeta,
  upsertPortrait,
} from "../store.ts";
import { clipChars, localDay, shiftDay } from "../time.ts";
import { newId } from "../../storage.ts";
import { lockedProfile } from "../../types.ts";
import { renderVariant, parsePromptBody } from "../prompts/doc.ts";
import { loadPrompt } from "../prompts/store.ts";
import {
  applyPortraitReview,
  formatOldPortrait,
  formatPortraitNoteLine,
  PORTRAIT_BODY_MAX,
  type PortraitOp,
} from "./portrait-life.ts";

const SCHEMA = {
  name: "portrait_self_bond",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["portrait_ops", "relationship", "self_summary", "bond_summary"],
    properties: {
      portrait_ops: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "topic", "body", "kind", "evidence_ids", "verdict"],
          properties: {
            id: { type: "string" },
            topic: { type: "string" },
            body: { type: "string" },
            kind: { type: "string" },
            evidence_ids: { type: "array", items: { type: "string" } },
            verdict: { type: "string" },
          },
        },
      },
      relationship: {
        type: "object",
        additionalProperties: false,
        required: ["body", "evidence_ids"],
        properties: {
          body: { type: "string" },
          evidence_ids: { type: "array", items: { type: "string" } },
        },
      },
      self_summary: { type: "string" },
      bond_summary: { type: "string" },
    },
  },
};

export function portraitVars(input: {
  charter: string;
  oldPortrait: string;
  selfSummary: string;
  bondSummary: string;
  notes: string;
  conversation: string;
  qingranNotes: string;
  rosieNotes: string;
}): Record<string, string> {
  return {
    system_prompt: input.charter,
    old_portrait: input.oldPortrait || "（没有）",
    old_self: input.selfSummary || "（没有）",
    old_bond: input.bondSummary || "（没有）",
    notes: input.notes || "（没有）",
    conversation: input.conversation || "（没有）",
    qingran_notes: input.qingranNotes || "（没有）",
    rosie_notes: input.rosieNotes || "（没有）",
  };
}

export async function portraitInputVars(day?: string): Promise<Record<string, string>> {
  const loaded = await loadPortraitGeneration(day);
  return loaded.vars;
}

export async function updatePortraitSelfBond(day: string, jobId?: string): Promise<void> {
  const loadedGen = await loadPortraitGeneration(day);
  const loaded = await loadPrompt("portrait");
  const messages = renderVariant(parsePromptBody("portrait", loaded.body), "main", loadedGen.vars);

  const result = await callModel("portrait", {
    ...asModelInput(messages),
    schema: SCHEMA,
    jobId,
    promptKey: loaded.key,
    promptHash: loaded.hash,
  });
  if (!result.json || typeof result.json !== "object") return;

  const parsed = result.json as {
    portrait_ops?: PortraitOp[];
    relationship?: { body?: string; evidence_ids?: string[] };
    self_summary?: string;
    bond_summary?: string;
  };
  if (!Array.isArray(parsed.portrait_ops) || !parsed.relationship || typeof parsed.relationship !== "object") return;
  const now = wallClock();
  const next = applyPortraitReview({
    existing: loadedGen.oldPortrait,
    ops: parsed.portrait_ops,
    relationship: parsed.relationship,
    evidenceDays: loadedGen.evidenceDays,
    now,
    activeMax: loadedGen.activeMax,
    staleDays: loadedGen.staleDays,
    allocateId: () => `p:${newId()}`,
  });
  for (const row of next) await upsertPortrait(row);
  const meta = loadedGen.meta;
  await patchMeta({
    selfSummary: clipChars(String(parsed.self_summary ?? meta.selfSummary), SELF_MAX_CHARS),
    bondSummary: clipChars(String(parsed.bond_summary ?? meta.bondSummary), BOND_MAX_CHARS),
    timeZone: meta.timeZone,
  });
}

async function loadPortraitGeneration(day?: string) {
  const meta = await getMeta();
  const profile = lockedProfile(await getProfileData());
  const end = day || localDay(wallClock(), meta.timeZone);
  const fromDay = shiftDay(end, -29);
  const notes = await listNotes({
    fromDay,
    toDay: end,
    status: "active",
    limit: 100,
  });
  const relevant = notes
    .filter((note) => note.subject === "rosie" || note.subject === "us" || note.subject === "qingran")
    .slice()
    .reverse();
  const oldPortrait = await listPortrait();
  const evidenceIds = [...new Set(oldPortrait.flatMap((row) => row.evidenceIds))];
  const extra = await listNotesByIds(evidenceIds);
  const evidenceDays = new Map<string, string>();
  for (const note of [...relevant, ...extra]) {
    if (note.localDay) evidenceDays.set(note.id, note.localDay);
  }
  const qingranNotes = relevant.filter((note) => note.subject === "qingran");
  const rosieNotes = relevant.filter((note) => note.subject === "rosie" || (note.subject === "us" && note.fromRosie));
  const recent = await listRecentMessages(30);
  const conversation = recent
    .filter((message) => !isNightNoiseBody(message.text))
    .map((message) => {
      const text = clipChars(modelFacingText(message.text), PORTRAIT_BODY_MAX);
      if (!text) return "";
      const who = message.role === "user" ? "你" : "我";
      return `${message.localDay ?? ""}|${who}|${text}`;
    })
    .filter(Boolean)
    .join("\n");
  const charter = await getProfilePrompt();
  const vars = portraitVars({
    charter,
    oldPortrait: formatOldPortrait(oldPortrait, meta.timeZone),
    selfSummary: meta.selfSummary,
    bondSummary: meta.bondSummary,
    notes: relevant.map(formatPortraitNoteLine).join("\n"),
    conversation,
    qingranNotes: qingranNotes.map((note) => `${note.id}|${clipChars(note.text, PORTRAIT_BODY_MAX)}`).join("\n"),
    rosieNotes: rosieNotes
      .map((note) => `${note.id}|${note.subject}|${clipChars(note.text, PORTRAIT_BODY_MAX)}`)
      .join("\n"),
  });
  return {
    vars,
    oldPortrait,
    evidenceDays,
    meta,
    activeMax: profile.portraitActiveMax,
    staleDays: profile.portraitStaleDays,
  };
}
