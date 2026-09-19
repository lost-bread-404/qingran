import { createServerFn } from "@tanstack/react-start";
import { getSql, dbSource } from "@/lib/db";
import { newId } from "../storage";
import { HEARING, isHearingProvider, SCRIPTED_CATEGORIES, EXPECTED_HEARING_MIGRATIONS, EXPECTED_CLIP_COLUMNS, type HearingProviderId } from "./config.ts";
import { formatUnknownError, hearingSaveError } from "./scripted.ts";
import {
  hearWithGemini,
  hearWithQwen,
  hearWithSelfhost,
  warmupSelfhost,
  clipFallbackRaw,
  type AdapterOutcome,
  type HearingCallOpts,
} from "./http.ts";
import { hearingCueSchema, type CueEmotion, type HearingCue, type HearingResult } from "./schema.ts";
import { assignSplits } from "./split.ts";
import { transcribeWithXai, xaiAsHearing } from "./xai.ts";
import { chooseHearing } from "./select.ts";
import { deleteHearingWav, putHearingWav, readHearingWav } from "./blob.ts";
import { isNoiseDisagreement, shouldDropAsNoise } from "./noise.ts";
import { goldTierFor, isGoldSource, type GoldSource } from "./gold.ts";
import { summarizeCoverage } from "./coverage.ts";
import { EMOTIONS } from "./schema.ts";
import type { AudioRoute, HearingMode } from "./route.ts";

export type HearingTurnPatch = {
  id: string;
  provider?: string;
  model?: string;
  speech_start?: number;
  endpoint_fired?: number;
  upload_start?: number;
  stt_done?: number;
  grok_done?: number;
  tts_first_audio?: number;
  latency_ms?: number;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  refusal?: boolean;
  fallback?: boolean;
  fallback_reason?: string;
  fallback_raw?: string | null;
  cold_start_ms?: number;
  disagreement?: boolean;
};

export type LabClipFilter = "all" | "confirmed" | "unconfirmed" | "disagreement";

export type RunHearingInput = {
  audioBase64: string;
  mimeType: string;
  liveText?: string;
  prompt?: string;
  provider: HearingProviderId;
  capture?: boolean;
  source?: "real" | "scripted";
  category?: string;
  turnId?: string;
  speech_start?: number;
  endpoint_fired?: number;
  upload_start?: number;
  context?: string;
  nbest?: boolean;
  extraKeyterms?: string[];
  debugHearing?: boolean;
  mode?: HearingMode;
  audioRoute?: AudioRoute;
};

export type RunHearingOutput = {
  ok: true;
  turnId: string;
  provider: string;
  model: string;
  tagged: string;
  text: string;
  xaiText: string;
  liveText: string;
  noise_only: boolean;
  disagreement: boolean;
  fallback: boolean;
  fallback_reason?: string;
  refusal: boolean;
  latency_ms: number;
  words: { text?: string; start?: number; end?: number }[];
  hearing: HearingResult | null;
  clipId?: string;
  saveError?: string;
  quota?: boolean;
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

export const unlockHearingLab = createServerFn({ method: "POST" })
  .validator((input: { password: string }) => input)
  .handler(async ({ data }) => {
    const secret = labSecret();
    if (!secret) return { ok: false as const, error: "未设置 HEARING_LAB_PASSWORD。" };
    if (data.password !== secret) return { ok: false as const, error: "密码不对。" };
    return { ok: true as const };
  });

export const runHearing = createServerFn({ method: "POST" })
  .validator((input: RunHearingInput) => input)
  .handler(async ({ data }): Promise<RunHearingOutput> => {
    const provider = isHearingProvider(data.provider) ? data.provider : "xai";
    const turnId = data.turnId || newId();
    const upload_start = data.upload_start || Date.now();
    const callOpts: HearingCallOpts = {
      context: data.context,
      nbest: Boolean(data.nbest),
    };
    const xaiPromise = transcribeWithXai({
      audioBase64: data.audioBase64,
      mimeType: data.mimeType,
      prompt: data.prompt,
      extraKeyterms: data.extraKeyterms,
    });
    const hearingPromise: Promise<AdapterOutcome | null> =
      provider === "xai" ? Promise.resolve(null) : dispatchProvider(provider, data.audioBase64, callOpts);
    const [xai, outcome] = await Promise.all([xaiPromise, hearingPromise]);

    const picked = chooseHearing({ provider, outcome, xai });
    if (!picked.hearing && !xai.ok && xai.quota) {
      return {
        ok: true,
        turnId,
        provider: "xai",
        model: HEARING.xai.model,
        tagged: "",
        text: "",
        xaiText: "",
        liveText: data.liveText ?? "",
        noise_only: true,
        disagreement: false,
        fallback: false,
        refusal: false,
        latency_ms: xai.latency_ms,
        words: [],
        hearing: null,
        quota: true,
      };
    }

    const { used, hearing, fallback, fallback_reason, xaiText, words, refusal } = picked;
    const providerNoise = Boolean(hearing?.noise_only && used !== "xai");
    const disagreement = isNoiseDisagreement(providerNoise, xaiText);
    const drop = shouldDropAsNoise(providerNoise, xaiText);
    const tagged = drop ? "" : disagreement ? xaiText : picked.tagged;
    const stt_done = Date.now();

    await upsertTurn({
      id: turnId,
      provider: used,
      model: hearing?.model || HEARING[used].model,
      speech_start: data.speech_start,
      endpoint_fired: data.endpoint_fired,
      upload_start,
      stt_done,
      latency_ms: hearing?.latency_ms ?? (xai.ok ? xai.latency_ms : 0),
      tokens_in: hearing?.tokens_in,
      tokens_out: hearing?.tokens_out,
      cost_usd: hearing?.cost_usd,
      refusal,
      fallback,
      fallback_reason,
      fallback_raw: clipFallbackRaw(outcome && !outcome.ok ? outcome.raw : undefined),
      disagreement,
    });

    let clipId: string | undefined;
    let saveError: string | undefined;
    if (data.capture) {
      try {
        clipId = await insertClip({
          audioBase64: data.audioBase64,
          durationMs: wavDurationMs(data.audioBase64),
          source: data.source === "scripted" ? "scripted" : "real",
          category: data.category,
          xaiText,
          hearing,
          tagged: used === "xai" ? xaiText : tagged,
          liveText: data.liveText ?? "",
          turnId,
          mode: data.mode,
          audioRoute: data.audioRoute,
          disagreement,
        });
      } catch (err) {
        clipId = undefined;
        saveError = hearingSaveError(err);
      }
    }

    return {
      ok: true,
      turnId,
      provider: used,
      model: hearing?.model || HEARING[used].model,
      tagged,
      text: hearing?.text ?? xaiText,
      xaiText,
      liveText: data.liveText ?? "",
      noise_only: drop,
      disagreement,
      fallback,
      fallback_reason,
      refusal,
      latency_ms: hearing?.latency_ms ?? (xai.ok ? xai.latency_ms : 0),
      words,
      hearing,
      clipId,
      saveError,
    };
  });

export const patchHearingTurn = createServerFn({ method: "POST" })
  .validator((input: HearingTurnPatch) => input)
  .handler(async ({ data }) => {
    await upsertTurn(data);
    return { ok: true as const };
  });

export const warmupHearing = createServerFn({ method: "POST" })
  .validator((input: { provider: HearingProviderId }) => input)
  .handler(async ({ data }) => {
    if (data.provider !== "selfhost") {
      return { ok: true as const, latency_ms: 0, cold: false };
    }
    const result = await warmupSelfhost();
    return { ok: result.ok, latency_ms: result.latency_ms, cold: result.cold, error: result.error };
  });

export const saveHearingClip = createServerFn({ method: "POST" })
  .validator(
    (input: {
      audioBase64: string;
      liveText?: string;
      xaiText?: string;
      tagged?: string;
      source?: "real" | "scripted";
      category?: string;
      hearing?: HearingResult | null;
      turnId?: string;
      mode?: HearingMode;
      audioRoute?: AudioRoute;
    }) => input,
  )
  .handler(async ({ data }) => {
    const clipId = await insertClip({
      audioBase64: data.audioBase64,
      durationMs: wavDurationMs(data.audioBase64),
      source: data.source === "scripted" ? "scripted" : "real",
      category: data.category,
      xaiText: data.xaiText ?? "",
      hearing: data.hearing ?? null,
      tagged: data.tagged ?? "",
      liveText: data.liveText ?? "",
      turnId: data.turnId,
      mode: data.mode,
      audioRoute: data.audioRoute,
      disagreement: false,
    });
    return { ok: true as const, clipId };
  });

export const confirmHearingClip = createServerFn({ method: "POST" })
  .validator(
    (input: {
      turnId: string;
      goldText: string;
      goldSource: GoldSource;
      utteranceEmotion?: string | null;
    }) => input,
  )
  .handler(async ({ data }) => {
    if (!isGoldSource(data.goldSource)) throw new Error("bad-gold-source");
    const emotion = isEmotion(data.utteranceEmotion) ? data.utteranceEmotion : null;
    const tier = goldTierFor({
      source: data.goldSource,
      emotionSet: Boolean(emotion),
      hasCues: false,
    });
    const sql = await getSql();
    const rows = await sql<{ id: string; gold_cues: unknown }>`
      select id, gold_cues from qingran_hearing_clips where turn_id = ${data.turnId}
      order by created_at desc
      limit 1
    `;
    const clip = rows[0];
    if (!clip) return { ok: false as const, error: "没有这段录音。" };
    const hasCues = Array.isArray(clip.gold_cues) && clip.gold_cues.length > 0;
    const nextTier = hasCues ? 3 : tier;
    await sql`
      update qingran_hearing_clips
      set gold_text = ${data.goldText},
          gold_source = ${data.goldSource},
          gold_tier = ${nextTier},
          utterance_emotion = ${emotion},
          stt_text = coalesce(stt_text, hearing_text, xai_text)
      where id = ${clip.id}
    `;
    return { ok: true as const, clipId: clip.id, goldTier: nextTier };
  });

export const listHearingClips = createServerFn({ method: "POST" })
  .validator((input: { password: string; relabel?: boolean; filter?: LabClipFilter }) => input)
  .handler(async ({ data }) => {
    assertLab(data.password);
    const sql = await getSql();
    const filter = data.filter ?? "all";
    const rows = await sql<{
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
      mode: string | null;
      audio_route: string | null;
      turn_id: string | null;
      disagreement: boolean | null;
      storage_backend: string | null;
      blob_error: string | null;
    }>`
      select id, created_at::text as created_at, duration_ms, source, category, split,
             xai_text, hearing_text, hearing_json, live_text,
             gold_text, gold_cues, noise_only, skip,
             relabel_gold_text, relabel_gold_cues, relabel_noise_only,
             gold_source, stt_text, gold_tier, utterance_emotion, mode, audio_route,
             turn_id, disagreement, storage_backend, blob_error
      from qingran_hearing_clips
      where ${filter === "confirmed" ? sql`gold_source is not null` : sql`true`}
        and ${filter === "unconfirmed" ? sql`gold_source is null` : sql`true`}
        and ${filter === "disagreement" ? sql`disagreement = true` : sql`true`}
      order by disagreement desc, created_at desc
      limit 400
    `;
    return {
      ok: true as const,
      clips: rows.map((row) => mapClipRow(row, data.relabel)),
    };
  });

export const hearingLabStats = createServerFn({ method: "POST" })
  .validator((input: { password: string }) => input)
  .handler(async ({ data }) => {
    assertLab(data.password);
    const sql = await getSql();
    const [turnCount] = await sql<{ n: number }>`select count(*)::int as n from qingran_hearing_turns`;
    const clips = await sql<{
      category: string | null;
      mode: string | null;
      gold_source: string | null;
      storage_backend: string | null;
    }>`
      select category, mode, gold_source, storage_backend from qingran_hearing_clips where skip = false
    `;
    const coverage = summarizeCoverage(clips, Number(turnCount?.n) || 0);
    return { ok: true as const, totalTurns: Number(turnCount?.n) || 0, coverage };
  });

export const getHearingClipAudio = createServerFn({ method: "POST" })
  .validator((input: { password: string; id: string }) => input)
  .handler(async ({ data }) => {
    assertLab(data.password);
    const sql = await getSql();
    const rows = await sql<{ audio_wav: string | null; blob_pathname: string | null }>`
      select audio_wav, blob_pathname from qingran_hearing_clips where id = ${data.id}
    `;
    const wav = rows[0]?.audio_wav;
    if (wav) return { ok: true as const, audioBase64: wav, mimeType: "audio/wav" };
    const fromBlob = rows[0]?.blob_pathname ? await readHearingWav(rows[0].blob_pathname) : null;
    if (!fromBlob) return { ok: false as const, error: "没有这段录音。" };
    return { ok: true as const, audioBase64: fromBlob, mimeType: "audio/wav" };
  });

export const saveHearingGold = createServerFn({ method: "POST" })
  .validator(
    (input: {
      password: string;
      id: string;
      relabel?: boolean;
      goldText?: string;
      goldCues?: HearingCue[];
      noiseOnly?: boolean;
      skip?: boolean;
      utteranceEmotion?: string | null;
    }) => input,
  )
  .handler(async ({ data }) => {
    assertLab(data.password);
    const cues = (data.goldCues ?? [])
      .map((cue) => hearingCueSchema.safeParse(cue))
      .filter((r) => r.success)
      .map((r) => r.data);
    const sql = await getSql();
    if (data.relabel) {
      await sql`
        update qingran_hearing_clips
        set relabel_gold_text = ${data.goldText ?? ""},
            relabel_gold_cues = ${JSON.stringify(cues)}::jsonb,
            relabel_noise_only = ${Boolean(data.noiseOnly)}
        where id = ${data.id}
      `;
    } else {
      const existing = await sql<{
        gold_source: string | null;
        stt_text: string | null;
        hearing_text: string | null;
        xai_text: string | null;
        utterance_emotion: string | null;
      }>`
        select gold_source, stt_text, hearing_text, xai_text, utterance_emotion
        from qingran_hearing_clips where id = ${data.id}
      `;
      const row = existing[0];
      const stt = row?.stt_text || row?.hearing_text || row?.xai_text || "";
      const goldText = data.goldText ?? "";
      const source = row?.gold_source
        ? row.gold_source
        : goldText && goldText !== stt
          ? "edited"
          : "confirmed";
      const emotion = isEmotion(data.utteranceEmotion)
        ? data.utteranceEmotion
        : isEmotion(row?.utterance_emotion)
          ? row?.utterance_emotion
          : null;
      const tier = goldTierFor({
        source,
        emotionSet: Boolean(emotion),
        hasCues: cues.length > 0,
      });
      await sql`
        update qingran_hearing_clips
        set gold_text = ${goldText},
            gold_cues = ${JSON.stringify(cues)}::jsonb,
            noise_only = ${Boolean(data.noiseOnly)},
            skip = ${Boolean(data.skip)},
            gold_source = ${source},
            gold_tier = ${tier},
            utterance_emotion = ${emotion},
            stt_text = coalesce(stt_text, hearing_text, xai_text)
        where id = ${data.id}
      `;
    }
    return { ok: true as const };
  });

export const deleteHearingClip = createServerFn({ method: "POST" })
  .validator((input: { password: string; id: string }) => input)
  .handler(async ({ data }) => {
    assertLab(data.password);
    await removeClip(data.id);
    return { ok: true as const };
  });

export const undoHearingClip = createServerFn({ method: "POST" })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }) => {
    await removeClip(data.id);
    return { ok: true as const };
  });

export const hearingLabDiagnostics = createServerFn({ method: "POST" })
  .validator((input: { password: string }) => input)
  .handler(async ({ data }) => {
    assertLab(data.password);
    const sql = await getSql();
    let migrations: string[] = [];
    let migrationsError: string | null = null;
    try {
      const rows = await sql<{ name: string }>`select name from _migrations order by name`;
      migrations = rows.map((r) => r.name);
    } catch (err) {
      migrationsError = formatUnknownError(err);
    }
    let clipCount = 0;
    let clipCountError: string | null = null;
    try {
      const rows = await sql<{ n: number }>`select count(*)::int as n from qingran_hearing_clips`;
      clipCount = Number(rows[0]?.n) || 0;
    } catch (err) {
      clipCountError = formatUnknownError(err);
    }
    let columns: string[] = [];
    try {
      const rows = await sql<{ column_name: string }>`
        select column_name
        from information_schema.columns
        where table_schema = 'public' and table_name = 'qingran_hearing_clips'
        order by ordinal_position
      `;
      columns = rows.map((r) => r.column_name);
    } catch {
      columns = [];
    }
    const missingMigrations = EXPECTED_HEARING_MIGRATIONS.filter((name) => !migrations.includes(name));
    const missingColumns = EXPECTED_CLIP_COLUMNS.filter((name) => !columns.includes(name));
    return {
      ok: true as const,
      dbSource,
      migrations,
      migrationsError,
      clipCount,
      clipCountError,
      columns,
      missingMigrations,
      missingColumns,
      blobTokenSet: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    };
  });

async function removeClip(id: string) {
  const sql = await getSql();
  const rows = await sql<{ blob_pathname: string | null }>`
    select blob_pathname from qingran_hearing_clips where id = ${id}
  `;
  await deleteHearingWav(rows[0]?.blob_pathname);
  await sql`delete from qingran_hearing_clips where id = ${id}`;
}

export const assignHearingSplits = createServerFn({ method: "POST" })
  .validator((input: { password: string }) => input)
  .handler(async ({ data }) => {
    assertLab(data.password);
    const sql = await getSql();
    const rows = await sql<{ id: string; category: string | null }>`
      select id, category from qingran_hearing_clips where skip = false
    `;
    const map = assignSplits(rows);
    for (const row of rows) {
      const split = map.get(row.id) ?? "dev";
      await sql`update qingran_hearing_clips set split = ${split} where id = ${row.id}`;
    }
    return { ok: true as const, assigned: rows.length };
  });

export const exportHearingClips = createServerFn({ method: "POST" })
  .validator((input: { password: string }) => input)
  .handler(async ({ data }) => {
    assertLab(data.password);
    const sql = await getSql();
    const rows = await sql<{
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
      audio_wav: string | null;
      blob_pathname: string | null;
      gold_source: string | null;
      stt_text: string | null;
      gold_tier: number | null;
      utterance_emotion: string | null;
      mode: string | null;
      audio_route: string | null;
      turn_id: string | null;
      disagreement: boolean | null;
      storage_backend: string | null;
    }>`
      select id, created_at::text as created_at, duration_ms, source, category, split,
             xai_text, hearing_text, hearing_json, live_text,
             gold_text, gold_cues, noise_only, skip,
             relabel_gold_text, relabel_gold_cues, relabel_noise_only, audio_wav, blob_pathname,
             gold_source, stt_text, gold_tier, utterance_emotion, mode, audio_route,
             turn_id, disagreement, storage_backend
      from qingran_hearing_clips
      order by created_at asc
    `;
    return {
      kind: "qingran-hearing-eval",
      version: 2,
      exportedAt: Date.now(),
      clips: await Promise.all(
        rows.map(async (row) => ({
          id: row.id,
          createdAt: row.created_at,
          durationMs: Number(row.duration_ms) || 0,
          source: row.source,
          category: row.category,
          split: row.split,
          xaiText: row.xai_text ?? "",
          hearingText: row.hearing_text ?? "",
          hearing: asHearing(row.hearing_json),
          liveText: row.live_text ?? "",
          goldText: row.gold_text ?? "",
          goldCues: parseCues(row.gold_cues),
          noiseOnly: Boolean(row.noise_only),
          skip: Boolean(row.skip),
          relabelGoldText: row.relabel_gold_text ?? "",
          relabelGoldCues: parseCues(row.relabel_gold_cues),
          relabelNoiseOnly: row.relabel_noise_only,
          audioBase64: row.audio_wav || (row.blob_pathname ? (await readHearingWav(row.blob_pathname)) ?? "" : ""),
          goldSource: row.gold_source,
          sttText: row.stt_text ?? "",
          goldTier: row.gold_tier,
          utteranceEmotion: row.utterance_emotion,
          mode: row.mode,
          audioRoute: row.audio_route,
          turnId: row.turn_id,
          disagreement: Boolean(row.disagreement),
          storageBackend: row.storage_backend,
        })),
      ),
    };
  });

export const scriptedQuota = createServerFn({ method: "GET" }).handler(async () => {
  const sql = await getSql();
  const rows = await sql<{ category: string; n: number }>`
    select category, count(*)::int as n
    from qingran_hearing_clips
    where source = 'scripted' and category is not null and skip = false
    group by category
  `;
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.category] = Number(row.n) || 0;
  return {
    categories: SCRIPTED_CATEGORIES.map((c) => ({
      ...c,
      have: counts[c.id] ?? 0,
    })),
  };
});

async function dispatchProvider(provider: HearingProviderId, audioBase64: string, opts?: HearingCallOpts) {
  if (provider === "qwen") return hearWithQwen(audioBase64, opts);
  if (provider === "gemini") return hearWithGemini(audioBase64, opts);
  if (provider === "selfhost") return hearWithSelfhost(audioBase64, opts);
  return xaiAsHearing("", 0);
}

async function upsertTurn(patch: HearingTurnPatch) {
  try {
    const sql = await getSql();
    await sql`
      insert into qingran_hearing_turns (
        id, provider, model, speech_start, endpoint_fired, upload_start, stt_done,
        grok_done, tts_first_audio, latency_ms, tokens_in, tokens_out, cost_usd,
        refusal, fallback, fallback_reason, fallback_raw, cold_start_ms, disagreement
      )
      values (
        ${patch.id},
        ${patch.provider ?? null},
        ${patch.model ?? null},
        ${patch.speech_start ?? null},
        ${patch.endpoint_fired ?? null},
        ${patch.upload_start ?? null},
        ${patch.stt_done ?? null},
        ${patch.grok_done ?? null},
        ${patch.tts_first_audio ?? null},
        ${patch.latency_ms ?? null},
        ${patch.tokens_in ?? null},
        ${patch.tokens_out ?? null},
        ${patch.cost_usd ?? null},
        ${Boolean(patch.refusal)},
        ${Boolean(patch.fallback)},
        ${patch.fallback_reason ?? null},
        ${patch.fallback_raw ?? null},
        ${patch.cold_start_ms ?? null},
        ${Boolean(patch.disagreement)}
      )
      on conflict (id) do update set
        provider = coalesce(excluded.provider, qingran_hearing_turns.provider),
        model = coalesce(excluded.model, qingran_hearing_turns.model),
        speech_start = coalesce(excluded.speech_start, qingran_hearing_turns.speech_start),
        endpoint_fired = coalesce(excluded.endpoint_fired, qingran_hearing_turns.endpoint_fired),
        upload_start = coalesce(excluded.upload_start, qingran_hearing_turns.upload_start),
        stt_done = coalesce(excluded.stt_done, qingran_hearing_turns.stt_done),
        grok_done = coalesce(excluded.grok_done, qingran_hearing_turns.grok_done),
        tts_first_audio = coalesce(excluded.tts_first_audio, qingran_hearing_turns.tts_first_audio),
        latency_ms = coalesce(excluded.latency_ms, qingran_hearing_turns.latency_ms),
        tokens_in = coalesce(excluded.tokens_in, qingran_hearing_turns.tokens_in),
        tokens_out = coalesce(excluded.tokens_out, qingran_hearing_turns.tokens_out),
        cost_usd = coalesce(excluded.cost_usd, qingran_hearing_turns.cost_usd),
        refusal = excluded.refusal or qingran_hearing_turns.refusal,
        fallback = excluded.fallback or qingran_hearing_turns.fallback,
        fallback_reason = coalesce(excluded.fallback_reason, qingran_hearing_turns.fallback_reason),
        fallback_raw = coalesce(excluded.fallback_raw, qingran_hearing_turns.fallback_raw),
        cold_start_ms = coalesce(excluded.cold_start_ms, qingran_hearing_turns.cold_start_ms),
        disagreement = excluded.disagreement or qingran_hearing_turns.disagreement
    `;
  } catch (err) {
    console.error("[hearing] upsertTurn failed:", err);
  }
}

async function insertClip(input: {
  audioBase64: string;
  durationMs: number;
  source: "real" | "scripted";
  category?: string;
  xaiText: string;
  hearing: HearingResult | null;
  tagged: string;
  liveText: string;
  turnId?: string;
  mode?: HearingMode;
  audioRoute?: AudioRoute;
  disagreement: boolean;
}): Promise<string> {
  const id = newId();
  const sql = await getSql();
  const bytes = Buffer.from(input.audioBase64, "base64");
  const stored = await putHearingWav(id, bytes);
  const storedPath = stored.pathname;
  const blobError = stored.error;
  const storageBackend = storedPath ? "blob" : "db";
  const audioWav = storedPath ? null : input.audioBase64;
  const sttText = input.tagged || input.xaiText;
  await sql`
    insert into qingran_hearing_clips (
      id, duration_ms, sample_rate, source, category, blob_pathname, audio_wav,
      xai_text, hearing_text, hearing_json, live_text,
      blob_error, storage_backend, stt_text, mode, audio_route, turn_id, disagreement
    )
    values (
      ${id},
      ${input.durationMs},
      16000,
      ${input.source},
      ${input.category ?? null},
      ${storedPath},
      ${audioWav},
      ${input.xaiText},
      ${input.tagged},
      ${input.hearing ? JSON.stringify(input.hearing) : null}::jsonb,
      ${input.liveText},
      ${blobError},
      ${storageBackend},
      ${sttText},
      ${input.mode ?? null},
      ${input.audioRoute ?? null},
      ${input.turnId ?? null},
      ${Boolean(input.disagreement)}
    )
  `;
  return id;
}

function wavDurationMs(base64: string): number {
  try {
    const buf = Buffer.from(base64, "base64");
    if (buf.length < 44) return 0;
    const byteRate = buf.readUInt32LE(28) || 32000;
    const dataSize = Math.max(0, buf.length - 44);
    return Math.round((dataSize / byteRate) * 1000);
  } catch {
    return 0;
  }
}

function asHearing(value: unknown): HearingResult | null {
  if (!value || typeof value !== "object") return null;
  return value as HearingResult;
}

function parseCues(value: unknown): HearingCue[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => hearingCueSchema.safeParse(item))
    .filter((r) => r.success)
    .map((r) => r.data);
}

function isEmotion(value: unknown): value is CueEmotion {
  return typeof value === "string" && (EMOTIONS as readonly string[]).includes(value);
}

function mapClipRow(
  row: {
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
    mode: string | null;
    audio_route: string | null;
    turn_id: string | null;
    disagreement: boolean | null;
    storage_backend: string | null;
    blob_error: string | null;
  },
  relabel?: boolean,
) {
  return {
    id: row.id,
    createdAt: row.created_at,
    durationMs: Number(row.duration_ms) || 0,
    source: row.source,
    category: row.category,
    split: row.split,
    xaiText: row.xai_text ?? "",
    hearingText: row.hearing_text ?? "",
    hearing: asHearing(row.hearing_json),
    liveText: row.live_text ?? "",
    goldText: relabel ? "" : (row.gold_text ?? ""),
    goldCues: relabel ? [] : parseCues(row.gold_cues),
    noiseOnly: relabel ? false : Boolean(row.noise_only),
    skip: Boolean(row.skip),
    hasGold: Boolean(row.gold_source || row.gold_text || row.gold_cues),
    hasRelabel: Boolean(row.relabel_gold_text || row.relabel_gold_cues),
    goldSource: relabel ? null : row.gold_source,
    sttText: row.stt_text ?? row.hearing_text ?? row.xai_text ?? "",
    goldTier: relabel ? null : row.gold_tier,
    utteranceEmotion: relabel ? null : row.utterance_emotion,
    mode: row.mode,
    audioRoute: row.audio_route,
    turnId: row.turn_id,
    disagreement: Boolean(row.disagreement),
    storageBackend: row.storage_backend,
    blobError: row.blob_error,
  };
}
