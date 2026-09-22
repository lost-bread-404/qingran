import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pendingMigrations } from "../../../../scripts/migration-plan.mjs";
import { confirmClipByTurn, exportReplyFlagDataset, goldCount, hallucinationCount, engineUseStats, insertClipRow, insertReplyFlag, listClipRows, listEvalClipIds, listEvalScoreRows, listLabeledClipRows, listReplyFlagRows, listScoreClipRows, patchFinalTextByTurn, unlabelClip, upsertEvalRun } from "./persist.ts";
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
    tags: ["没懂我", "空话", "胡说"],
  });
  const flags = await listReplyFlagRows(sql);
  assert.equal(flags.length, 1);
  assert.equal(flags[0]?.triggerText, "在吗");
  assert.equal(flags[0]?.replyText, "嗯，在。");
  assert.equal(flags[0]?.note, "答非所问");
  assert.deepEqual(flags[0]?.tags, ["没懂我", "空话"]);
  const exported = exportReplyFlagDataset(flags);
  assert.equal(exported.kind, "qingran-prompt-eval");
  assert.equal(exported.flags[0]?.triggerText, "在吗");
  assert.equal(exported.flags[0]?.promptHash, "deadbeefcafe");
  assert.deepEqual(exported.flags[0]?.tags, ["没懂我", "空话"]);
});

test("PGLite e2e: empty gold is labeled no-speech, not a fallback to STT", async () => {
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

  await insertClipRow(sql, {
    id: "clip-empty",
    durationMs: 400,
    source: "real",
    audioWav: silenceWavBase64(0.4),
    xaiText: "谢谢观看",
    hearingText: "谢谢观看",
    hearingJson: null,
    liveText: "",
    storageBackend: "db",
    sttText: "谢谢观看",
    turnId: "turn-empty",
    disagreement: false,
    finalText: "谢谢观看",
  });

  const confirmed = await confirmClipByTurn(sql, {
    turnId: "turn-empty",
    goldText: "",
    goldSource: "edited",
    noiseOnly: true,
  });
  assert.equal(confirmed.ok, true);
  assert.equal(await goldCount(sql), 1);
  const labeled = await listLabeledClipRows(sql, 1);
  assert.equal(labeled.clips[0]?.goldText, "");
  assert.equal(labeled.clips[0]?.goldSource, "edited");
  assert.equal(labeled.clips[0]?.noiseOnly, true);
  const raw = await sql<{ gold_text: string | null; gold_source: string | null }>`
    select gold_text, gold_source from qingran_hearing_clips where id = 'clip-empty'
  `;
  assert.equal(raw[0]?.gold_text, "");
  assert.equal(raw[0]?.gold_source, "edited");

  const scored = await listScoreClipRows(sql);
  const card = scoreHearing(
    scored.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      finalText: row.final_text ?? "",
      xaiText: row.xai_text ?? "",
      liveText: row.live_text ?? "",
      goldText: row.gold_text ?? "",
      goldSource: row.gold_source,
      noiseOnly: Boolean(row.noise_only),
      utteranceEmotion: row.utterance_emotion,
      turnId: row.turn_id,
    })),
  );
  assert.equal(card.goldN, 1);
  assert.equal(card.cerFinal, 1);
  assert.equal(card.worst[0]?.gold, "");
  assert.equal(card.worst[0]?.hyp, "谢谢观看");
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

test("0011 preroll migration only adds clip columns", async () => {
  const sql = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), "../../../../migrations/0011_hearing_preroll.sql"),
    "utf8",
  );
  assert.match(sql, /add column if not exists hear_to_trigger_ms/);
  assert.match(sql, /add column if not exists preroll_peak_rms/);
  assert.doesNotMatch(sql, /drop column/i);
  assert.doesNotMatch(sql, /alter column/i);
  assert.doesNotMatch(sql, /\bupdate\b/i);
  assert.doesNotMatch(sql, /\bdelete\b/i);
});

test("0012 engine migration only adds turn columns", async () => {
  const sql = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), "../../../../migrations/0012_hearing_engine.sql"),
    "utf8",
  );
  assert.match(sql, /add column if not exists engine_requested/);
  assert.match(sql, /add column if not exists engine_used/);
  assert.match(sql, /add column if not exists audio_llm_ms/);
  assert.match(sql, /add column if not exists engine_fallback_reason/);
  assert.doesNotMatch(sql, /drop column/i);
  assert.doesNotMatch(sql, /alter column/i);
  assert.doesNotMatch(sql, /\bupdate\b/i);
  assert.doesNotMatch(sql, /\bdelete\b/i);
});

test("0014 engine error detail migration only adds a turn column", async () => {
  const sql = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), "../../../../migrations/0014_hearing_engine_error.sql"),
    "utf8",
  );
  assert.match(sql, /add column if not exists engine_error_detail/);
  assert.doesNotMatch(sql, /drop column/i);
  assert.doesNotMatch(sql, /alter column/i);
  assert.doesNotMatch(sql, /\bupdate\b/i);
  assert.doesNotMatch(sql, /\bdelete\b/i);
});

test("PGLite e2e: engine mix counts used engines and fallback reasons", async () => {
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

  await sql`
    insert into qingran_hearing_turns (id, provider, engine_requested, engine_used, engine_fallback_reason)
    values
      ('e1', 'gemini', 'gemini', 'gemini', null),
      ('e2', 'gemini', 'gemini', 'gemini', null),
      ('e3', 'xai', 'gemini', 'xai', 'timeout'),
      ('e4', 'xai', 'gemini', 'xai', 'refusal')
  `;
  const stats = await engineUseStats(sql, "7d");
  assert.equal(stats.n, 4);
  assert.deepEqual(stats.used, [
    { engine: "gemini", n: 2 },
    { engine: "xai", n: 2 },
  ]);
  assert.deepEqual(stats.fallback, [
    { reason: "timeout", n: 1 },
    { reason: "refused", n: 1 },
  ]);

  await sql`
    insert into qingran_hearing_turns (id, provider, engine_requested, engine_used, engine_fallback_reason, engine_error_detail)
    values ('e5', 'xai', 'gemini', 'xai', 'http', '503 {"error":"UNAVAILABLE"}')
  `;
  const detail = await sql.query<{ engine_error_detail: string | null }>(
    "select engine_error_detail from qingran_hearing_turns where id = $1",
    ["e5"],
  );
  assert.equal(detail[0]?.engine_error_detail, '503 {"error":"UNAVAILABLE"}');
});

test("0013 eval-run migration only adds the comparison table", async () => {
  const sql = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), "../../../../migrations/0013_eval_runs.sql"),
    "utf8",
  );
  assert.match(sql, /create table if not exists qingran_eval_runs/);
  assert.match(sql, /unique \(clip_id, engine\)/);
  assert.match(sql, /tags jsonb/);
  assert.match(sql, /latency_ms/);
  assert.doesNotMatch(sql, /drop table/i);
  assert.doesNotMatch(sql, /drop column/i);
  assert.doesNotMatch(sql, /alter column/i);
  assert.doesNotMatch(sql, /\bupdate\b/i);
  assert.doesNotMatch(sql, /\bdelete\b/i);
  assert.doesNotMatch(sql, /qingran_hearing_turns/);
  assert.doesNotMatch(sql, /qingran_messages/);
});

test("PGLite e2e: eval runs overwrite the same clip+engine and only use labeled audio", async () => {
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
    id: "clip-eval-1",
    durationMs: 400,
    source: "real",
    audioWav: wav,
    xaiText: "在吗",
    hearingText: "在吗",
    hearingJson: null,
    liveText: "",
    storageBackend: "db",
    sttText: "在吗",
    turnId: "turn-eval-1",
    disagreement: false,
    finalText: "在吗",
  });
  await insertClipRow(sql, {
    id: "clip-eval-2",
    durationMs: 400,
    source: "real",
    audioWav: wav,
    xaiText: "嗯",
    hearingText: "嗯",
    hearingJson: null,
    liveText: "",
    storageBackend: "db",
    sttText: "嗯",
    turnId: "turn-eval-2",
    disagreement: false,
    finalText: "嗯",
  });
  await insertClipRow(sql, {
    id: "clip-eval-unlabeled",
    durationMs: 400,
    source: "real",
    audioWav: wav,
    xaiText: "嗨",
    hearingText: "嗨",
    hearingJson: null,
    liveText: "",
    storageBackend: "db",
    sttText: "嗨",
    turnId: "turn-eval-unlabeled",
    disagreement: false,
    finalText: "嗨",
  });
  await insertClipRow(sql, {
    id: "clip-eval-silent",
    durationMs: 400,
    source: "real",
    audioWav: null,
    xaiText: "空",
    hearingText: "空",
    hearingJson: null,
    liveText: "",
    storageBackend: "db",
    sttText: "空",
    turnId: "turn-eval-silent",
    disagreement: false,
    finalText: "空",
  });

  assert.deepEqual(await listEvalClipIds(sql), []);
  const labeled1 = await confirmClipByTurn(sql, {
    turnId: "turn-eval-1",
    goldText: "在吗",
    goldSource: "edited",
    goldTags: { length: "short", events: ["laugh"] },
    tagsTouched: ["length", "events"],
  });
  assert.equal(labeled1.ok, true);
  const labeled2 = await confirmClipByTurn(sql, {
    turnId: "turn-eval-2",
    goldText: "嗯呐",
    goldSource: "confirmed",
  });
  assert.equal(labeled2.ok, true);
  const labeledSilent = await confirmClipByTurn(sql, {
    turnId: "turn-eval-silent",
    goldText: "空",
    goldSource: "edited",
  });
  assert.equal(labeledSilent.ok, true);

  assert.deepEqual(await listEvalClipIds(sql), ["clip-eval-2", "clip-eval-1"]);
  assert.deepEqual(await listEvalClipIds(sql, 1), ["clip-eval-2"]);

  await upsertEvalRun(sql, {
    id: "run-old",
    clipId: "clip-eval-1",
    engine: "gemini",
    text: "旧识别",
    tags: { length: "long" },
    latencyMs: 12,
    status: "ok",
    error: null,
  });
  await upsertEvalRun(sql, {
    id: "run-new",
    clipId: "clip-eval-1",
    engine: "gemini",
    text: "在吗",
    tags: { length: "short", events: ["laugh"] },
    latencyMs: 34,
    status: "ok",
    error: null,
  });
  await upsertEvalRun(sql, {
    id: "run-xai",
    clipId: "clip-eval-1",
    engine: "xai",
    text: "",
    tags: null,
    latencyMs: 8000,
    status: "timeout",
    error: "TimeoutError",
  });

  const stored = await sql<{
    id: string;
    clip_id: string;
    engine: string;
    text: string | null;
    latency_ms: number | null;
    status: string;
  }>`
    select id, clip_id, engine, text, latency_ms, status
    from qingran_eval_runs
    order by engine
  `;
  assert.equal(stored.length, 2);
  assert.equal(stored[0]?.engine, "gemini");
  assert.equal(stored[0]?.id, "run-old");
  assert.equal(stored[0]?.text, "在吗");
  assert.equal(stored[0]?.latency_ms, 34);
  assert.equal(stored[0]?.status, "ok");
  assert.equal(stored[1]?.engine, "xai");
  assert.equal(stored[1]?.status, "timeout");

  const scored = await listEvalScoreRows(sql, { engines: ["gemini"] });
  assert.equal(scored.length, 1);
  assert.equal(scored[0]?.engine, "gemini");
  assert.equal(scored[0]?.text, "在吗");
  assert.equal(scored[0]?.goldText, "在吗");
  assert.equal(scored[0]?.goldTags?.length, "short");
  assert.deepEqual(scored[0]?.goldTags?.events, ["laugh"]);
  assert.equal(scored[0]?.tags?.length, "short");

  const messages = await sql<{ n: number }>`select count(*)::int as n from qingran_messages`;
  const turns = await sql<{ n: number }>`select count(*)::int as n from qingran_hearing_turns`;
  assert.equal(messages[0]?.n, 0);
  assert.equal(turns[0]?.n, 0);
});

test("0015 confusions migration is additive", async () => {
  const sql = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), "../../../../migrations/0015_hearing_confusions.sql"),
    "utf8",
  );
  assert.match(sql, /qingran_hearing_confusions/);
  assert.match(sql, /qingran_personal_lexicon/);
  assert.match(sql, /add column if not exists prosody/);
  assert.match(sql, /stt_corrected_text/);
  assert.match(sql, /stt_corrections/);
  assert.doesNotMatch(sql, /drop column/i);
  assert.doesNotMatch(sql, /alter column/i);
});

test("0020 turn_feedback tags migration is additive", async () => {
  const sql = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), "../../../../migrations/0020_turn_feedback_tags.sql"),
    "utf8",
  );
  assert.match(sql, /alter table turn_feedback/);
  assert.match(sql, /add column if not exists tags text\[\]/);
  assert.match(sql, /qingran_reply_flags/);
  assert.doesNotMatch(sql, /drop column/i);
  assert.doesNotMatch(sql, /alter column/i);
  assert.doesNotMatch(sql, /\bupdate\b/i);
  assert.doesNotMatch(sql, /\bdelete\b/i);
});

