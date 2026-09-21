import { createServerFn } from "@tanstack/react-start";
import { getSql } from "../../db.ts";
import { now } from "./clock.ts";
import {
  getMeta,
  listActiveNotes,
  listPortrait,
  patchMeta,
  resetMind,
  upsertNote,
  upsertPortrait,
} from "./store.ts";
import type { Note, PortraitRow } from "./types.ts";
import seed from "../../../../seed/story.json";

export type StoryNoteSeed = {
  id: string;
  text: string;
  tags: string[];
  subject: "rosie" | "qingran" | "us";
  lens: Array<"diary" | "bond">;
  from_rosie: boolean;
  weight: number;
  happened_at: number | string;
  local_day: string;
  links: string[];
};

export type StoryPortraitSeed = {
  id: string;
  topic: string;
  body: string;
};

export type StorySeed = {
  version: number;
  timezone?: string;
  portrait: StoryPortraitSeed[];
  notes: StoryNoteSeed[];
};

function labSecret(): string {
  if (process.env.HEARING_LAB_PASSWORD) return process.env.HEARING_LAB_PASSWORD;
  if (!process.env.DATABASE_URL) return "qingran";
  return "";
}

function assertLab(password: string) {
  const secret = labSecret();
  if (!secret || password !== secret) throw new Error("lab-locked");
}

function happenedAtMs(value: number | string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const n = Date.parse(String(value));
  if (!Number.isFinite(n)) throw new Error(`bad happened_at: ${value}`);
  return n;
}

export function loadStorySeed(): StorySeed {
  return seed as StorySeed;
}

export async function importStorySeed(data: StorySeed = loadStorySeed()): Promise<{
  notes: number;
  portrait: number;
}> {
  const db = await getSql();
  const ts = now();
  await db.query("delete from mem_notes");
  await db.query("delete from mem_history");
  await db.query("delete from qr_portrait");
  await resetMind();

  for (const row of data.portrait) {
    const portrait: PortraitRow = {
      id: row.id,
      topic: row.topic,
      body: row.body,
      status: "active",
      evidenceIds: [],
      lastSeen: ts,
      updatedAt: ts,
    };
    await upsertPortrait(portrait);
  }

  for (const row of data.notes) {
    const at = happenedAtMs(row.happened_at);
    const note: Note = {
      id: row.id,
      text: row.text,
      tags: row.tags ?? [],
      aliases: [],
      subject: row.subject,
      lens: row.lens?.length ? row.lens : ["bond"],
      fromRosie: Boolean(row.from_rosie),
      weight: Math.max(1, Math.min(5, Number(row.weight) || 3)),
      status: "active",
      supersededBy: null,
      links: row.links ?? [],
      happenedAt: at,
      localDay: row.local_day,
      sourceIds: ["story"],
      recallCount: 0,
      lastRecalledAt: null,
      createdAt: ts,
      updatedAt: ts,
    };
    await upsertNote(note, undefined, "STORY");
  }

  const meta = await getMeta();
  await patchMeta({
    notesVersion: (meta.notesVersion || 0) + 1,
    coreIndex: { version: 0, day: "", ids: [] },
  });
  return { notes: data.notes.length, portrait: data.portrait.length };
}

export const previewStorySeed = createServerFn({ method: "POST" })
  .validator((input: { password: string }) => input)
  .handler(async ({ data }) => {
    try {
      assertLab(data.password);
      const seedData = loadStorySeed();
      return {
        ok: true as const,
        version: seedData.version,
        notes: seedData.notes.length,
        portrait: seedData.portrait.length,
      };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

export const importStoryLine = createServerFn({ method: "POST" })
  .validator((input: { password: string; confirm: string }) => input)
  .handler(async ({ data }) => {
    try {
      assertLab(data.password);
      if (data.confirm !== "清空并导入") {
        return { ok: false as const, error: "需要二次确认。" };
      }
      const result = await importStorySeed();
      return { ok: true as const, ...result };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

export const listStoryMemory = createServerFn({ method: "POST" })
  .validator((input: { password: string }) => input)
  .handler(async ({ data }) => {
    try {
      assertLab(data.password);
      const [notes, portrait] = await Promise.all([listActiveNotes(), listPortrait()]);
      return {
        ok: true as const,
        notes: notes
          .slice()
          .sort((a, b) => a.happenedAt - b.happenedAt || a.id.localeCompare(b.id))
          .map((n) => ({
            id: n.id,
            text: n.text,
            tags: n.tags,
            subject: n.subject,
            lens: n.lens,
            fromRosie: n.fromRosie,
            weight: n.weight,
            happenedAt: n.happenedAt,
            localDay: n.localDay,
            links: n.links,
          })),
        portrait: portrait.map((p) => ({
          id: p.id,
          topic: p.topic,
          body: p.body,
          status: p.status,
        })),
      };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
        notes: [],
        portrait: [],
      };
    }
  });
