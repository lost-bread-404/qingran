import { goldTierFor, isGoldSource, type GoldSource } from "./gold.ts";
import { hearingCueSchema, EMOTIONS, type CueEmotion, type HearingCue } from "./schema.ts";

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
};

export async function insertClipRow(sql: Sql, input: InsertClipRowInput): Promise<void> {
  await sql`
    insert into qingran_hearing_clips (
      id, duration_ms, sample_rate, source, category, blob_pathname, audio_wav,
      xai_text, hearing_text, hearing_json, live_text,
      blob_error, storage_backend, stt_text, mode, audio_route, turn_id, disagreement,
      final_text, peak_rms, vad_floor
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
      ${input.vadFloor ?? null}
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
        gold_at = null
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
  }>(
    `select id, turn_id, final_text, gold_text, gold_source,
            noise_only, literal_mismatch, tone_note, gold_at::text as gold_at
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
    stt_text: string | null;
    hearing_text: string | null;
    noise_only: boolean | null;
    utterance_emotion: string | null;
    literal_mismatch: boolean | null;
    tone_note: string | null;
    turn_id: string | null;
  }>(
    `select id, created_at::text as created_at,
            final_text, xai_text, live_text, gold_text, stt_text, hearing_text,
            noise_only, utterance_emotion, literal_mismatch, tone_note, turn_id
     from qingran_hearing_clips
     order by created_at desc`,
  );
}

export async function hallucinationCount(sql: Sql, window: "7d" | "all"): Promise<number> {
  const rows =
    window === "7d"
      ? await sql<{ n: number }>`
          select count(*)::int as n
          from qingran_hearing_turns
          where hallucination_suspect = true
            and created_at >= now() - interval '7 days'
        `
      : await sql<{ n: number }>`
          select count(*)::int as n
          from qingran_hearing_turns
          where hallucination_suspect = true
        `;
  return Number(rows[0]?.n) || 0;
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
