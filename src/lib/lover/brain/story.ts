import { createServerFn } from "@tanstack/react-start";
import { listActiveNotes, listPortrait } from "./store.ts";
import seed from "../../../../seed/story.json" with { type: "json" };

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

export function loadStorySeed(): StorySeed {
  return seed as StorySeed;
}

export async function importStorySeed(data: StorySeed = loadStorySeed()): Promise<{
  notes: number;
  portrait: number;
}> {
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
      return { ok: false as const, error: "故事线不再写入笔记和画像。到设置里「从旧记忆生成初版」。" };
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
