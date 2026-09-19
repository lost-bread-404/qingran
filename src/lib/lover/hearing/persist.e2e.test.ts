import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pendingMigrations } from "../../../../scripts/migration-plan.mjs";
import { confirmClipByTurn, insertClipRow, listClipRows } from "./persist.ts";
import { silenceWavBase64 } from "./wav.ts";

type Sql = {
  <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
};

type Run = <T>(text: string, params: unknown[]) => Promise<T[]>;

function toSql(run: Run): Sql {
  const sql = (async <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> => {
    let text = strings[0];
    for (let i = 0; i < values.length; i += 1) text += `$${i + 1}${strings[i + 1]}`;
    return run<T>(text, values);
  }) as unknown as Sql;
  sql.query = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => run<T>(text, params);
  return sql;
}

test("PGLite e2e: voice round → clip → confirm → confirmed filter", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  await pg.exec(
    "create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../../migrations");
  const entries = await readdir(dir);
  const files = Object.fromEntries(
    await Promise.all(
      entries
        .filter((name) => name.endsWith(".sql"))
        .map(async (name) => [name, await readFile(join(dir, name), "utf8")] as const),
    ),
  );
  for (const { name } of pendingMigrations(Object.keys(files), [])) {
    await pg.exec(files[name] ?? "");
    await pg.query("insert into _migrations (name) values ($1)", [name]);
  }

  const sql = toSql(async <T>(text: string, params: unknown[]) => {
    const result = await pg.query<T>(text, params);
    return result.rows;
  });

  const wav = silenceWavBase64(0.4);
  await insertClipRow(sql, {
    id: "clip-1",
    durationMs: 400,
    source: "real",
    category: null,
    audioWav: wav,
    xaiText: "在吗",
    hearingText: "在吗",
    hearingJson: null,
    liveText: "",
    storageBackend: "db",
    sttText: "在吗",
    turnId: "turn-1",
    disagreement: false,
  });

  const before = await listClipRows(sql, "confirmed");
  assert.equal(before.length, 0);

  const confirmed = await confirmClipByTurn(sql, {
    turnId: "turn-1",
    goldText: "在吗",
    goldSource: "confirmed",
    utteranceEmotion: "neutral",
    noiseOnly: false,
  });
  assert.equal(confirmed.ok, true);

  const after = await listClipRows(sql, "confirmed");
  assert.equal(after.length, 1);
  assert.equal(after[0]?.turn_id, "turn-1");
  assert.equal(after[0]?.gold_source, "confirmed");
  assert.equal(after[0]?.stt_text, "在吗");
});
