import { goldTierFor, isGoldSource, type GoldSource } from "./gold.ts";
import { hearingCueSchema, EMOTIONS, type CueEmotion, type HearingCue } from "./schema.ts";
import { aggregateEngineUse, type EngineUseStats } from "./select.ts";
import {
  parseAcousticTags,
  parsePartialAcousticTags,
  parseTagKeys,
  type AcousticTags,
  type TagKey,
} from "./tags.ts";

export type Sql = {
  <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
};

export type LabClipFilter = "all" | "confirmed" | "unconfirmed" | "disagreement";

export type InsertClipRowInput = {
  id: string;
  durationMs: number;
  source: "real" | "scripted";
  category?: string | null;
  blobPathname?: string | null;
  audioWav?: string | null;
  xaiText: string;
  hearingText: string;
  hearingJson?: string | null;
  liveText: string;
  blobError?: string | null;
  storageBackend: string;
  sttText: string;
  mode?: string | null;
  audioRoute?: string | null;
  turnId?: string | null;
  disagreement: boolean;
  finalText?: string | null;
  peakRms?: number | null;
  vadFloor?: number | null;
  hearToTriggerMs?: number | null;
  prerollPeakRms?: number | null;
  predictedTags?: AcousticTags | null;
  commitSha?: string | null;
  promptHash?: string | null;
  contextBefore?: unknown;
};

export async function insertClipRow(sql: Sql, input: InsertClipRowInput): Promise<void> {
  await sql`
    insert into qingran_hearing_clips (
      id, duration_ms, sample_rate, source, category, blob_pathname, audio_wav,
      xai_text, hearing_text, hearing_json, live_text,
      blob_error, storage_backend, stt_text, mode, audio_route, turn_id, disagreement,
      final_text, peak_rms, vad_floor, hear_to_trigger_ms, preroll_peak_rms,
      predicted_tags, commit_sha, prompt_hash, context_before
    )
    values (
      ${input.id},
      ${input.durationMs},
      16000,
      ${input.source},
      ${input.category ?? null},
      ${input.blobPathname ?? null},
      ${input.audioWav ?? null},
      ${input.xaiText},
      ${input.hearingText},
      ${input.hearingJson}::jsonb,
      ${input.liveText},
      ${input.blobError ?? null},
      ${input.storageBackend},
      ${input.sttText},
      ${input.mode ?? null},
      ${input.audioRoute ?? null},
      ${input.turnId ?? null},
      ${Boolean(input.disagreement)},
      ${input.finalText ?? null},
      ${input.peakRms ?? null},
      ${input.vadFloor ?? null},
      ${input.hearToTriggerMs ?? null},
      ${input.prerollPeakRms ?? null},
      ${input.predictedTags ? JSON.stringify(input.predictedTags) : null}::jsonb,
      ${input.commitSha ?? null},
      ${input.promptHash ?? null},
      ${input.contextBefore ? JSON.stringify(input.contextBefore) : null}::jsonb
    )
  `;
}

export async function confirmClipByTurn(
  sql: Sql,
  input: {
    turnId: string;
    goldText: string;
    goldSource: GoldSource;
    utteranceEmotion?: string | null;
    noiseOnly?: boolean;
    literalMismatch?: boolean;
    toneNote?: string | null;
    goldTags?: Partial<AcousticTags> | null;
    tagsTouched?: TagKey[] | null;
  },
): Promise<{ ok: true; clipId: string; goldTier: number } | { ok: false; error: string }> {
  if (!isGoldSource(input.goldSource)) return { ok: false, error: "bad-gold-source" };
  const emotion = isEmotion(input.utteranceEmotion) ? input.utteranceEmotion : null;
  const rows = await sql<{ id: string; gold_cues: unknown }>`
    select id, gold_cues from qingran_hearing_clips where turn_id = ${input.turnId}
    order by created_at desc
    limit 1
  `;
  const clip = rows[0];
  if (!clip) {
    const failed = await sql<{ save_error: string | null }>`
      select save_error from qingran_hearing_turns where id = ${input.turnId}
    `;
    return { ok: false, error: failed[0]?.save_error || "没有这段录音。" };
  }
  const hasCues = Array.isArray(clip.gold_cues) && clip.gold_cues.length > 0;
  const tier = goldTierFor({
    source: input.goldSource,
    emotionSet: Boolean(emotion),
    hasCues,
  });
  const nextTier = hasCues ? 3 : tier;
  const note = input.toneNote?.trim() || null;
  const touchTags = input.tagsTouched !== undefined;
  const goldTags =
    touchTags && input.goldTags && Object.keys(input.goldTags).length ? JSON.stringify(input.goldTags) : null;
  const touched = touchTags && input.tagsTouched?.length ? input.tagsTouched : null;
  if (touchTags) {
    await sql`
      update qingran_hearing_clips
      set gold_text = ${input.goldText},
          gold_source = ${input.goldSource},
          gold_tier = ${nextTier},
          utterance_emotion = coalesce(${emotion}, utterance_emotion),
          noise_only = ${Boolean(input.noiseOnly)},
          literal_mismatch = ${Boolean(input.literalMismatch)},
          tone_note = ${note},
          gold_at = now(),
          gold_tags = ${goldTags}::jsonb,
          tags_touched = ${touched},
          stt_text = coalesce(stt_text, hearing_text, xai_text)
      where id = ${clip.id}
    `;
  } else {
    await sql`
      update qingran_hearing_clips
      set gold_text = ${input.goldText},
          gold_source = ${input.goldSource},
          gold_tier = ${nextTier},
          utterance_emotion = coalesce(${emotion}, utterance_emotion),
          noise_only = ${Boolean(input.noiseOnly)},
          literal_mismatch = ${Boolean(input.literalMismatch)},
          tone_note = ${note},
          gold_at = now(),
          stt_text = coalesce(stt_text, hearing_text, xai_text)
      where id = ${clip.id}
    `;
  }
  return { ok: true, clipId: clip.id, goldTier: nextTier };
}

export async function unlabelClip(
  sql: Sql,
  input: { clipId?: string; turnId?: string },
): Promise<{ ok: true; clipId: string } | { ok: false; error: string }> {
  const rows = input.clipId
    ? await sql<{ id: string }>`select id from qingran_hearing_clips where id = ${input.clipId} limit 1`
    : input.turnId
      ? await sql<{ id: string }>`
          select id from qingran_hearing_clips
          where turn_id = ${input.turnId}
          order by created_at desc
          limit 1
        `
      : [];
  const clip = rows[0];
  if (!clip) return { ok: false, error: "没有这段录音。" };
  await sql`
    update qingran_hearing_clips
    set gold_text = null,
        gold_source = null,
        gold_tier = 0,
        gold_cues = null,
        noise_only = false,
        literal_mismatch = false,
        tone_note = null,
        gold_at = null,
        gold_tags = null,
        tags_touched = null
    where id = ${clip.id}
  `;
  return { ok: true, clipId: clip.id };
}

export const LABELED_PAGE_SIZE = 30;

export type LabeledClipRow = {
  id: string;
  turnId: string | null;
  finalText: string;
  goldText: string;
  goldSource: string | null;
  noiseOnly: boolean;
  literalMismatch: boolean;
  toneNote: string | null;
  goldAt: string | null;
  predictedTags: AcousticTags | null;
  goldTags: Partial<AcousticTags> | null;
  tagsTouched: TagKey[];
  hearToTriggerMs: number | null;
  prerollPeakRms: number | null;
};

export async function listLabeledClipRows(sql: Sql, page = 1) {
  const p = Math.max(1, Math.floor(Number(page) || 1));
  const offset = (p - 1) * LABELED_PAGE_SIZE;
  const rows = await sql.query<{
    id: string;
    turn_id: string | null;
    final_text: string | null;
    gold_text: string | null;
    gold_source: string | null;
    noise_only: boolean | null;
    literal_mismatch: boolean | null;
    tone_note: string | null;
    gold_at: string | null;
    predicted_tags: unknown;
    gold_tags: unknown;
    tags_touched: string[] | null;
    hear_to_trigger_ms: number | null;
    preroll_peak_rms: number | null;
  }>(
    `select id, turn_id, final_text, gold_text, gold_source,
            noise_only, literal_mismatch, tone_note, gold_at::text as gold_at,
            predicted_tags, gold_tags, tags_touched,
            hear_to_trigger_ms, preroll_peak_rms
     from qingran_hearing_clips
     where gold_source is not null
     order by coalesce(gold_at, created_at) desc, id desc
     limit $1 offset $2`,
    [LABELED_PAGE_SIZE, offset],
  );
  const count = await sql<{ n: number }>`
    select count(*)::int as n from qingran_hearing_clips where gold_source is not null
  `;
  return {
    clips: rows.map(
      (row): LabeledClipRow => ({
        id: row.id,
        turnId: row.turn_id,
        finalText: row.final_text ?? "",
        goldText: row.gold_text ?? "",
        goldSource: row.gold_source,
        noiseOnly: Boolean(row.noise_only),
        literalMismatch: Boolean(row.literal_mismatch),
        toneNote: row.tone_note,
        goldAt: row.gold_at,
        predictedTags: parseAcousticTags(row.predicted_tags),
        goldTags: parsePartialAcousticTags(row.gold_tags),
        tagsTouched: parseTagKeys(row.tags_touched),
        hearToTriggerMs: row.hear_to_trigger_ms == null ? null : Number(row.hear_to_trigger_ms),
        prerollPeakRms: row.preroll_peak_rms == null ? null : Number(row.preroll_peak_rms),
      }),
    ),
    total: Number(count[0]?.n) || 0,
    page: p,
    pageSize: LABELED_PAGE_SIZE,
  };
}

export async function patchFinalTextByTurn(sql: Sql, turnId: string, finalText: string) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const rows = await sql<{ id: string }>`
      update qingran_hearing_clips
      set final_text = ${finalText}
      where turn_id = ${turnId}
      returning id
    `;
    if (rows[0]?.id) return;
    await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)));
  }
}

export async function listClipRows(sql: Sql, filter: LabClipFilter = "all") {
  const where =
    filter === "confirmed"
      ? "gold_source is not null"
      : filter === "unconfirmed"
        ? "gold_source is null"
        : filter === "disagreement"
          ? "disagreement = true"
          : "true";
  return sql.query<{
    id: string;
    created_at: string;
    duration_ms: number | null;
    source: string;
    category: string | null;
    split: string | null;
    xai_text: string | null;
    hearing_text: string | null;
    hearing_json: unknown;
    live_text: string | null;
    gold_text: string | null;
    gold_cues: unknown;
    noise_only: boolean | null;
    skip: boolean;
    relabel_gold_text: string | null;
    relabel_gold_cues: unknown;
    relabel_noise_only: boolean | null;
    gold_source: string | null;
    stt_text: string | null;
    gold_tier: number | null;
    utterance_emotion: string | null;
    literal_mismatch: boolean | null;
    tone_note: string | null;
    mode: string | null;
    audio_route: string | null;
    turn_id: string | null;
    disagreement: boolean | null;
    storage_backend: string | null;
    blob_error: string | null;
    final_text: string | null;
    peak_rms: number | null;
    vad_floor: number | null;
  }>(
    `select id, created_at::text as created_at, duration_ms, source, category, split,
            xai_text, hearing_text, hearing_json, live_text,
            gold_text, gold_cues, noise_only, skip,
            relabel_gold_text, relabel_gold_cues, relabel_noise_only,
            gold_source, stt_text, gold_tier, utterance_emotion, literal_mismatch, tone_note,
            mode, audio_route,
            turn_id, disagreement, storage_backend, blob_error,
            final_text, peak_rms, vad_floor
     from qingran_hearing_clips
     where ${where}
     order by disagreement desc, created_at desc
     limit 400`,
  );
}

export async function clipCount(sql: Sql): Promise<number> {
  const rows = await sql<{ n: number }>`select count(*)::int as n from qingran_hearing_clips`;
  return Number(rows[0]?.n) || 0;
}

export async function goldCount(sql: Sql): Promise<number> {
  const rows = await sql<{ n: number }>`
    select count(*)::int as n from qingran_hearing_clips where gold_source is not null
  `;
  return Number(rows[0]?.n) || 0;
}

export async function listScoreClipRows(sql: Sql) {
  return sql.query<{
    id: string;
    created_at: string;
    final_text: string | null;
    xai_text: string | null;
    live_text: string | null;
    gold_text: string | null;
    gold_source: string | null;
    stt_text: string | null;
    hearing_text: string | null;
    noise_only: boolean | null;
    utterance_emotion: string | null;
    literal_mismatch: boolean | null;
    tone_note: string | null;
    turn_id: string | null;
    predicted_tags: unknown;
    gold_tags: unknown;
    tags_touched: string[] | null;
  }>(
    `select id, created_at::text as created_at,
            final_text, xai_text, live_text, gold_text, gold_source, stt_text, hearing_text,
            noise_only, utterance_emotion, literal_mismatch, tone_note, turn_id,
            predicted_tags, gold_tags, tags_touched
     from qingran_hearing_clips
     order by created_at desc`,
  );
}

export async function hallucinationCount(sql: Sql, window: "7d" | "all"): Promise<number> {
  const by = await hallucinationCountByReason(sql, window);
  return by.apple_empty + by.short_quiet;
}

export type HallucinationByReason = { apple_empty: number; short_quiet: number };

export async function hallucinationCountByReason(
  sql: Sql,
  window: "7d" | "all",
): Promise<HallucinationByReason> {
  const rows =
    window === "7d"
      ? await sql<{ reason: string; n: number }>`
          select case
                   when fallback_reason = 'apple_empty' then 'apple_empty'
                   else 'short_quiet'
                 end as reason,
                 count(*)::int as n
          from qingran_hearing_turns
          where hallucination_suspect = true
            and created_at >= now() - interval '7 days'
          group by 1
        `
      : await sql<{ reason: string; n: number }>`
          select case
                   when fallback_reason = 'apple_empty' then 'apple_empty'
                   else 'short_quiet'
                 end as reason,
                 count(*)::int as n
          from qingran_hearing_turns
          where hallucination_suspect = true
          group by 1
        `;
  const out: HallucinationByReason = { apple_empty: 0, short_quiet: 0 };
  for (const row of rows) {
    if (row.reason === "apple_empty") out.apple_empty = Number(row.n) || 0;
    else out.short_quiet += Number(row.n) || 0;
  }
  return out;
}

export async function engineUseStats(sql: Sql, window: "7d" | "all"): Promise<EngineUseStats> {
  const rows =
    window === "7d"
      ? await sql<{ engine: string | null; reason: string | null; n: number }>`
          select coalesce(nullif(engine_used, ''), nullif(provider, ''), 'xai') as engine,
                 engine_fallback_reason as reason,
                 count(*)::int as n
          from qingran_hearing_turns
          where created_at >= now() - interval '7 days'
          group by 1, 2
        `
      : await sql<{ engine: string | null; reason: string | null; n: number }>`
          select coalesce(nullif(engine_used, ''), nullif(provider, ''), 'xai') as engine,
                 engine_fallback_reason as reason,
                 count(*)::int as n
          from qingran_hearing_turns
          group by 1, 2
        `;
  return aggregateEngineUse(rows);
}

export async function listMigrationNames(sql: Sql): Promise<string[]> {
  const rows = await sql<{ name: string }>`select name from _migrations order by name`;
  return rows.map((row) => row.name);
}

export async function goldStatusByTurnIds(sql: Sql, turnIds: string[]) {
  const out: { turnId: string; goldSource: string | null; clipId: string }[] = [];
  const seen = new Set<string>();
  for (const turnId of turnIds) {
    if (!turnId || seen.has(turnId)) continue;
    const rows = await sql<{ turn_id: string; gold_source: string | null; id: string }>`
      select turn_id, gold_source, id
      from qingran_hearing_clips
      where turn_id = ${turnId}
      order by created_at desc
      limit 1
    `;
    const row = rows[0];
    if (!row?.turn_id) continue;
    seen.add(row.turn_id);
    out.push({ turnId: row.turn_id, goldSource: row.gold_source, clipId: row.id });
  }
  return out;
}

export function parseCues(value: unknown): HearingCue[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => hearingCueSchema.safeParse(item))
    .filter((r) => r.success)
    .map((r) => r.data);
}

function isEmotion(value: unknown): value is CueEmotion {
  return typeof value === "string" && (EMOTIONS as readonly string[]).includes(value);
}

export async function patchReplyMessageId(sql: Sql, turnId: string, replyMessageId: string) {
  await sql`
    update qingran_hearing_clips
    set reply_message_id = ${replyMessageId}
    where turn_id = ${turnId} and reply_message_id is null
  `;
  await sql`
    update qingran_hearing_turns
    set reply_message_id = ${replyMessageId}
    where id = ${turnId} and reply_message_id is null
  `;
}

export type ReplyFlagRow = {
  id: string;
  messageId: string;
  replyToMessageId: string | null;
  note: string;
  createdAt: string;
  commitSha: string | null;
  promptHash: string | null;
  triggerText: string;
  replyText: string;
};

export async function insertReplyFlag(
  sql: Sql,
  input: {
    id: string;
    messageId: string;
    replyToMessageId?: string | null;
    note: string;
    commitSha?: string | null;
    promptHash?: string | null;
  },
) {
  await sql`
    insert into qingran_reply_flags (
      id, message_id, reply_to_message_id, note, commit_sha, prompt_hash
    )
    values (
      ${input.id},
      ${input.messageId},
      ${input.replyToMessageId ?? null},
      ${input.note},
      ${input.commitSha ?? null},
      ${input.promptHash ?? null}
    )
  `;
}

export async function listReplyFlagRows(sql: Sql): Promise<ReplyFlagRow[]> {
  const rows = await sql.query<{
    id: string;
    message_id: string;
    reply_to_message_id: string | null;
    note: string | null;
    created_at: string;
    commit_sha: string | null;
    prompt_hash: string | null;
    trigger_text: string | null;
    reply_text: string | null;
  }>(
    `select f.id, f.message_id, f.reply_to_message_id, f.note,
            f.created_at::text as created_at, f.commit_sha, f.prompt_hash,
            t.body as trigger_text, r.body as reply_text
     from qingran_reply_flags f
     left join qingran_messages t on t.id = f.reply_to_message_id
     left join qingran_messages r on r.id = f.message_id
     order by f.created_at desc
     limit 200`,
  );
  return rows.map((row) => ({
    id: row.id,
    messageId: row.message_id,
    replyToMessageId: row.reply_to_message_id,
    note: row.note ?? "",
    createdAt: row.created_at,
    commitSha: row.commit_sha,
    promptHash: row.prompt_hash,
    triggerText: visibleMessageBody(row.trigger_text),
    replyText: visibleMessageBody(row.reply_text),
  }));
}

export function exportReplyFlagDataset(rows: ReplyFlagRow[]) {
  return {
    kind: "qingran-prompt-eval" as const,
    version: 1,
    exportedAt: Date.now(),
    flags: rows.map((row) => ({
      messageId: row.messageId,
      replyToMessageId: row.replyToMessageId,
      triggerText: row.triggerText,
      replyText: row.replyText,
      note: row.note,
      createdAt: row.createdAt,
      commitSha: row.commitSha,
      promptHash: row.promptHash,
    })),
  };
}

export type ClipLabelRow = {
  predictedTags: AcousticTags | null;
  goldTags: Partial<AcousticTags> | null;
  tagsTouched: TagKey[];
  noiseOnly: boolean;
  literalMismatch: boolean;
  toneNote: string | null;
  goldText: string;
  xaiText: string;
};

export async function clipLabelByTurn(sql: Sql, turnId: string): Promise<ClipLabelRow | null> {
  const rows = await sql<{
    predicted_tags: unknown;
    gold_tags: unknown;
    tags_touched: string[] | null;
    noise_only: boolean | null;
    literal_mismatch: boolean | null;
    tone_note: string | null;
    gold_text: string | null;
    xai_text: string | null;
  }>`
    select predicted_tags, gold_tags, tags_touched, noise_only, literal_mismatch, tone_note, gold_text, xai_text
    from qingran_hearing_clips
    where turn_id = ${turnId}
    order by created_at desc
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    predictedTags: parseAcousticTags(row.predicted_tags),
    goldTags: parsePartialAcousticTags(row.gold_tags),
    tagsTouched: parseTagKeys(row.tags_touched),
    noiseOnly: Boolean(row.noise_only),
    literalMismatch: Boolean(row.literal_mismatch),
    toneNote: row.tone_note,
    goldText: row.gold_text ?? "",
    xaiText: row.xai_text ?? "",
  };
}

function visibleMessageBody(body: string | null): string {
  if (!body) return "";
  let text = body;
  if (text.startsWith("⟦已扫⟧")) text = text.slice(4);
  const hear = text.match(/^⟦听:[^⟧]+⟧/);
  if (hear) text = text.slice(hear[0].length);
  const gas = text.match(/^⟦气:[^⟧]+⟧/);
  if (gas) text = text.slice(gas[0].length);
  const reply = text.match(/^⟦回:[^⟧]+⟧/);
  if (reply) text = text.slice(reply[0].length);
  if (text.startsWith("⟦走向⟧") || text.startsWith("⟦设定⟧") || text.startsWith("⟦未听⟧")) {
    text = text.slice(4);
  }
  return text;
}
