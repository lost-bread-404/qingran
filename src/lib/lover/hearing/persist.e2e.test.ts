import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pendingMigrations } from "../../../../scripts/migration-plan.mjs";
import { confirmClipByTurn, exportReplyFlagDataset, goldCount, hallucinationCount, insertClipRow, insertReplyFlag, listClipRows, listLabeledClipRows, listReplyFlagRows, listScoreClipRows, patchFinalTextByTurn, unlabelClip } from "./persist.ts";
import { scoreHearing } from "./score.ts";
import { silenceWavBase64 } from "./wav.ts";
import type { AcousticTags } from "./tags.ts";

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
    finalText: "在吗",
    peakRms: 0.04,
    vadFloor: 0.008,
  });

  const before = await listClipRows(sql, "confirmed");
  assert.equal(before.length, 0);

  const confirmed = await confirmClipByTurn(sql, {
    turnId: "turn-1",
    goldText: "在吗",
    goldSource: "confirmed",
    noiseOnly: false,
    literalMismatch: true,
    toneNote: "反话",
  });
  assert.equal(confirmed.ok, true);

  const after = await listClipRows(sql, "confirmed");
  assert.equal(after.length, 1);
  assert.equal(after[0]?.turn_id, "turn-1");
  assert.equal(after[0]?.gold_source, "confirmed");
  assert.equal(after[0]?.stt_text, "在吗");
  assert.equal(after[0]?.peak_rms, 0.04);
  assert.equal(after[0]?.vad_floor, 0.008);
  assert.equal(after[0]?.literal_mismatch, true);
  assert.equal(after[0]?.tone_note, "反话");
  assert.equal(await goldCount(sql), 1);

  await patchFinalTextByTurn(sql, "turn-1", "在吗呀");
  const patched = await listClipRows(sql, "confirmed");
  assert.equal(patched[0]?.final_text, "在吗呀");

  const scored = await listScoreClipRows(sql);
  assert.equal(scored[0]?.id, "clip-1");
  assert.equal(scored[0]?.final_text, "在吗呀");
  assert.equal(await hallucinationCount(sql, "all"), 0);

  const labeledPage = await listLabeledClipRows(sql, 1);
  assert.equal(labeledPage.total, 1);
  assert.equal(labeledPage.clips[0]?.id, "clip-1");
  assert.equal(labeledPage.clips[0]?.goldSource, "confirmed");

  const beforeUnlabel = scoreHearing(
    scored.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      finalText: row.final_text ?? "",
      xaiText: row.xai_text ?? "",
      liveText: row.live_text ?? "",
      goldText: row.gold_text ?? "",
      noiseOnly: Boolean(row.noise_only),
      utteranceEmotion: row.utterance_emotion,
      turnId: row.turn_id,
    })),
  );
  assert.equal(beforeUnlabel.goldN, 1);

  const unlabeled = await unlabelClip(sql, { turnId: "turn-1" });
  assert.equal(unlabeled.ok, true);
  assert.equal(await goldCount(sql), 0);
  const stillThere = await listClipRows(sql, "all");
  assert.equal(stillThere.length, 1);
  assert.equal(stillThere[0]?.gold_source ?? null, null);
  assert.ok(!stillThere[0]?.gold_text);
  const afterUnlabelRows = await listScoreClipRows(sql);
  const afterUnlabel = scoreHearing(
    afterUnlabelRows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      finalText: row.final_text ?? "",
      xaiText: row.xai_text ?? "",
      liveText: row.live_text ?? "",
      goldText: row.gold_text ?? "",
      noiseOnly: Boolean(row.noise_only),
      utteranceEmotion: row.utterance_emotion,
      turnId: row.turn_id,
    })),
  );
  assert.equal(afterUnlabel.goldN, 0);
  assert.equal(afterUnlabel.clipN, 1);
  assert.equal(afterUnlabel.exactMatch, null);
  assert.equal((await listLabeledClipRows(sql, 1)).total, 0);

  const reedited = await confirmClipByTurn(sql, {
    turnId: "turn-1",
    goldText: "在吗呀",
    goldSource: "edited",
  });
  assert.equal(reedited.ok, true);
  const afterEditRows = await listScoreClipRows(sql);
  const afterEdit = scoreHearing(
    afterEditRows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      finalText: row.final_text ?? "",
      xaiText: row.xai_text ?? "",
      liveText: row.live_text ?? "",
      goldText: row.gold_text ?? "",
      noiseOnly: Boolean(row.noise_only),
      utteranceEmotion: row.utterance_emotion,
      turnId: row.turn_id,
    })),
  );
  assert.equal(afterEdit.goldN, 1);
  assert.equal(afterEdit.exactMatch, 1);
  assert.equal(afterEdit.cerFinal, 0);
  const relisted = await listLabeledClipRows(sql, 1);
  assert.equal(relisted.clips[0]?.goldSource, "edited");
});

test("PGLite e2e: predicted tags, tags_touched gold, ✓ keeps tags, reply flags export", async () => {
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

  const predicted: AcousticTags = { length: "short", contour: "flat", voice: "normal", events: [] };
  await insertClipRow(sql, {
    id: "clip-tags",
    durationMs: 400,
    source: "real",
    audioWav: silenceWavBase64(0.4),
    xaiText: "嗯",
    hearingText: "嗯〔short·flat·normal｜〕",
    hearingJson: null,
    liveText: "",
    storageBackend: "db",
    sttText: "嗯",
    turnId: "turn-tags",
    disagreement: false,
    finalText: "嗯〔short·flat·normal｜〕",
    predictedTags: { ...predicted },
    commitSha: "abc123",
    promptHash: "deadbeefcafe",
    contextBefore: [
      { role: "user", text: "在吗" },
      { role: "assistant", text: "在" },
    ],
  });

  const edited = await confirmClipByTurn(sql, {
    turnId: "turn-tags",
    goldText: "嗯",
    goldSource: "edited",
    goldTags: { contour: "rising" },
    tagsTouched: ["contour"],
  });
  assert.equal(edited.ok, true);
  const labeled = await listLabeledClipRows(sql, 1);
  assert.deepEqual(labeled.clips[0]?.tagsTouched, ["contour"]);
  assert.equal(labeled.clips[0]?.goldTags?.contour, "rising");
  assert.equal(labeled.clips[0]?.predictedTags?.length, "short");

  const quick = await confirmClipByTurn(sql, {
    turnId: "turn-tags",
    goldText: "嗯呐",
    goldSource: "confirmed",
  });
  assert.equal(quick.ok, true);
  const afterQuick = await listLabeledClipRows(sql, 1);
  assert.equal(afterQuick.clips[0]?.goldText, "嗯呐");
  assert.deepEqual(afterQuick.clips[0]?.tagsTouched, ["contour"]);
  assert.equal(afterQuick.clips[0]?.goldTags?.contour, "rising");

  await sql`insert into qingran_messages (id, role, body, created_at) values ('u1', 'user', '在吗', 1)`;
  await sql`insert into qingran_messages (id, role, body, created_at) values ('a1', 'assistant', '嗯，在。', 2)`;
  await insertReplyFlag(sql, {
    id: "flag-1",
    messageId: "a1",
    replyToMessageId: "u1",
    note: "答非所问",
    commitSha: "abc123",
    promptHash: "deadbeefcafe",
  });
  const flags = await listReplyFlagRows(sql);
  assert.equal(flags.length, 1);
  assert.equal(flags[0]?.triggerText, "在吗");
  assert.equal(flags[0]?.replyText, "嗯，在。");
  assert.equal(flags[0]?.note, "答非所问");
  const exported = exportReplyFlagDataset(flags);
  assert.equal(exported.kind, "qingran-prompt-eval");
  assert.equal(exported.flags[0]?.triggerText, "在吗");
  assert.equal(exported.flags[0]?.promptHash, "deadbeefcafe");
});

test("0010 eval-tag migration only adds columns and tables", async () => {
  const sql = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), "../../../../migrations/0010_hearing_eval_tags.sql"),
    "utf8",
  );
  assert.match(sql, /add column if not exists predicted_tags/);
  assert.match(sql, /create table if not exists qingran_reply_flags/);
  assert.doesNotMatch(sql, /drop column/i);
  assert.doesNotMatch(sql, /alter column/i);
  assert.doesNotMatch(sql, /\bupdate\b/i);
  assert.doesNotMatch(sql, /\bdelete\b/i);
});
