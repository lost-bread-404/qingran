import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { RECENT_CLIP_KEEP } from "../brain/config.ts";
import { dropOldHearingClipFiles, type Sql } from "./persist.ts";

test("recent voice clips default to the last 20", () => {
  assert.equal(RECENT_CLIP_KEEP, 20);
});

test("old clip files go away but the rows stay", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(`
    create table qingran_hearing_clips (
      id text primary key,
      created_at timestamptz not null,
      source text,
      blob_pathname text,
      audio_wav text,
      gold_text text,
      gold_source text,
      blob_error text
    )
  `);
  const sql = (async <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]> => {
    let text = strings[0] ?? "";
    for (let i = 0; i < values.length; i += 1) text += `$${i + 1}${strings[i + 1] ?? ""}`;
    const result = await pg.query<T>(text, values);
    return result.rows;
  }) as Sql;

  async function add(input: {
    id: string;
    at: string;
    source?: string;
    audio?: string | null;
    path?: string | null;
    gold?: string | null;
    goldSource?: string | null;
  }) {
    await sql`
      insert into qingran_hearing_clips (
        id, created_at, source, audio_wav, blob_pathname, gold_text, gold_source
      ) values (
        ${input.id},
        ${input.at},
        ${input.source ?? "real"},
        ${input.audio === undefined ? "wav" : input.audio},
        ${input.path ?? null},
        ${input.gold ?? null},
        ${input.goldSource ?? null}
      )
    `;
  }

  await add({ id: "old", at: "2026-01-01T00:00:00Z", path: "hearing/old.wav" });
  await add({ id: "mid", at: "2026-01-02T00:00:00Z" });
  await add({ id: "new", at: "2026-01-03T00:00:00Z" });
  await add({ id: "gold", at: "2025-01-01T00:00:00Z", gold: "在吗", goldSource: "edited", path: "hearing/gold.wav" });
  await add({ id: "lab", at: "2025-06-01T00:00:00Z", source: "scripted", path: "hearing/lab.wav" });

  const paths = await dropOldHearingClipFiles(sql, 2);
  assert.deepEqual(paths, ["hearing/old.wav"]);

  const rows = await sql<{ id: string; audio_wav: string | null; blob_pathname: string | null; blob_error: string | null }>`
    select id, audio_wav, blob_pathname, blob_error from qingran_hearing_clips order by id
  `;
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(rows.length, 5);
  assert.equal(byId.get("old")?.audio_wav, null);
  assert.equal(byId.get("old")?.blob_pathname, null);
  assert.equal(byId.get("old")?.blob_error, "pruned");
  assert.equal(byId.get("mid")?.audio_wav, "wav");
  assert.equal(byId.get("new")?.audio_wav, "wav");
  assert.equal(byId.get("gold")?.blob_pathname, "hearing/gold.wav");
  assert.equal(byId.get("lab")?.blob_pathname, "hearing/lab.wav");
});
