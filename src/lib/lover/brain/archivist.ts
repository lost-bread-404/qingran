import { ARCHIVE_BATCH_MAX, ARCHIVE_MIN_OVERFLOW, HISTORY_WINDOW, SESSION_GAP_MS } from "./config.ts";
import { enqueue } from "./jobs.ts";
import { callModel } from "./llm.ts";
import { validateOps, type RawOp } from "./archive-ops.ts";
import {
  addLink,
  bumpNotesVersion,
  getNote,
  heavyRecentNotes,
  lastMessageBefore,
  listMessagesByIds,
  listNotes,
  markArchived,
  supersedeNote,
  unarchivedForDay,
  unarchivedForSession,
  unarchivedOverflow,
  upsertNote,
} from "./store.ts";
import type { Note, StoredMessage } from "./types.ts";
import { ARCHIVIST_SYSTEM } from "./voice/prompts.ts";
import { getMemoryIndex } from "./voice/retrieve.ts";

const SCHEMA = {
  name: "archive_ops",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["ops"],
    properties: {
      ops: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "op",
            "target_id",
            "text",
            "tags",
            "subject",
            "lens",
            "from_rosie",
            "weight",
            "links",
            "happened_at",
            "source_ids",
          ],
          properties: {
            op: { type: "string", enum: ["ADD", "SUPERSEDE"] },
            target_id: { type: "string" },
            text: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            subject: { type: "string", enum: ["rosie", "qingran", "us"] },
            lens: { type: "array", items: { type: "string", enum: ["diary", "bond"] } },
            from_rosie: { type: "boolean" },
            weight: { type: "integer" },
            links: { type: "array", items: { type: "string" } },
            happened_at: { type: "string" },
            source_ids: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  },
};

export { validateOps };

async function candidateNotes(batch: StoredMessage[]): Promise<Note[]> {
  const { mini, items } = await getMemoryIndex();
  const query = batch.map((m) => m.text).join(" ").slice(0, 800);
  const hits = query.trim() ? mini.search(query).slice(0, 30) : [];
  const hitIds = hits.map((h) => h.id);
  const fromIndex = items.filter((i) => hitIds.includes(i.id));
  const recentHeavy = await heavyRecentNotes(7, 4);
  const merged = new Map<string, Note>();
  for (const item of fromIndex) {
    const n = await getNote(item.id);
    if (n) merged.set(n.id, n);
  }
  for (const n of recentHeavy) merged.set(n.id, n);
  if (merged.size < 8) {
    const extra = await listNotes({ status: "active", limit: 20 });
    for (const n of extra) merged.set(n.id, n);
  }
  return [...merged.values()].slice(0, 50);
}

export async function runArchivist(ids: string[], jobId?: string): Promise<void> {
  const batch = ids.length ? await listMessagesByIds(ids) : [];
  if (!batch.length) return;
  if (batch.every((m) => m.archivedAt)) return;
  const pending = batch.filter((m) => !m.archivedAt);
  if (!pending.length) return;

  const candidates = await candidateNotes(pending);
  const result = await callModel("archive", {
    system: ARCHIVIST_SYSTEM,
    input: `【已有相关笔记】（id|日期|subject|text）
${candidates.map((n) => `${n.id}|${n.localDay}|${n.subject}|${n.text}`).join("\n") || "（没有）"}

【对话】（id|时间|说话人|内容）
${pending
  .map((m) => `${m.id}|${new Date(m.createdAt).toISOString()}|${m.role === "user" ? "Rosie" : "清然"}|${m.text}`)
  .join("\n")}

输出 JSON：{"ops":[...]}`,
    schema: SCHEMA,
    jobId,
  });
  if (!result.ok) throw new Error("archivist-llm-failed");
  const rawOps = Array.isArray((result.json as { ops?: unknown })?.ops)
    ? ((result.json as { ops: RawOp[] }).ops ?? [])
    : [];
  const valid = validateOps(rawOps, pending, candidates);
  for (const item of valid) {
    await upsertNote(item.note, jobId, item.supersede ? "SUPERSEDE" : "ADD");
    if (item.supersede) await supersedeNote(item.supersede, item.note.id, jobId);
    for (const link of item.links) await addLink(item.note.id, link);
  }
  await markArchived(
    pending.map((m) => m.id),
    Date.now(),
  );
  await bumpNotesVersion();
}

export async function enqueueArchiveIfNeeded(userCreatedAt = Date.now()): Promise<void> {
  const overflow = await unarchivedOverflow(ARCHIVE_BATCH_MAX);
  if (overflow.length >= ARCHIVE_MIN_OVERFLOW) {
    const batch = overflow.slice(0, ARCHIVE_BATCH_MAX);
    await enqueue("archive", `archive:${batch[0]!.id}`, { ids: batch.map((m) => m.id) });
  }
  const prev = await lastMessageBefore(userCreatedAt);
  if (prev && userCreatedAt - prev.createdAt >= SESSION_GAP_MS && prev.sessionId) {
    const session = await unarchivedForSession(prev.sessionId);
    if (session.length) {
      for (let i = 0; i < session.length; i += ARCHIVE_BATCH_MAX) {
        const batch = session.slice(i, i + ARCHIVE_BATCH_MAX);
        await enqueue("archive", `archive:${batch[0]!.id}`, { ids: batch.map((m) => m.id) });
      }
    }
  }
}

export async function archiveDaySync(day: string, jobId?: string): Promise<void> {
  const pending = await unarchivedForDay(day);
  for (let i = 0; i < pending.length; i += ARCHIVE_BATCH_MAX) {
    const batch = pending.slice(i, i + ARCHIVE_BATCH_MAX);
    await runArchivist(
      batch.map((m) => m.id),
      jobId,
    );
  }
}

export { HISTORY_WINDOW };
