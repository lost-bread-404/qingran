import { createServerFn } from "@tanstack/react-start";
import { getSql } from "@/lib/db";
import { newId } from "../storage";
import { HEARING, isHearingProvider, SCRIPTED_CATEGORIES, type HearingProviderId } from "./config.ts";
import { hearWithGemini, hearWithQwen, hearWithSelfhost, warmupSelfhost, type AdapterOutcome } from "./http.ts";
import { hearingCueSchema, type HearingCue, type HearingResult } from "./schema.ts";
import { assignSplits } from "./split.ts";
import { transcribeWithXai, xaiAsHearing } from "./xai.ts";
import { chooseHearing } from "./select.ts";

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
  cold_start_ms?: number;
};

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
  fallback: boolean;
  fallback_reason?: string;
  refusal: boolean;
  latency_ms: number;
  words: { text?: string; start?: number; end?: number }[];
  hearing: HearingResult | null;
  clipId?: string;
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
    const xaiPromise = transcribeWithXai({
      audioBase64: data.audioBase64,
      mimeType: data.mimeType,
      prompt: data.prompt,
    });
    const hearingPromise: Promise<AdapterOutcome | null> =
      provider === "xai" ? Promise.resolve(null) : dispatchProvider(provider, data.audioBase64);
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
        fallback: false,
        refusal: false,
        latency_ms: xai.latency_ms,
        words: [],
        hearing: null,
        quota: true,
      };
    }

    const { used, hearing, fallback, fallback_reason, tagged, xaiText, words, refusal } = picked;
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
    });

    let clipId: string | undefined;
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
        });
      } catch {
        clipId = undefined;
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
      noise_only: Boolean(hearing?.noise_only && used !== "xai"),
      fallback,
      fallback_reason,
      refusal,
      latency_ms: hearing?.latency_ms ?? (xai.ok ? xai.latency_ms : 0),
      words,
      hearing,
      clipId,
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
    });
    return { ok: true as const, clipId };
  });

export const listHearingClips = createServerFn({ method: "POST" })
  .validator((input: { password: string; relabel?: boolean }) => input)
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
    }>`
      select id, created_at::text as created_at, duration_ms, source, category, split,
             xai_text, hearing_text, hearing_json, live_text,
             gold_text, gold_cues, noise_only, skip,
             relabel_gold_text, relabel_gold_cues, relabel_noise_only
      from qingran_hearing_clips
      order by created_at desc
      limit 400
    `;
    return {
      ok: true as const,
      clips: rows.map((row) => ({
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
        goldText: data.relabel ? "" : (row.gold_text ?? ""),
        goldCues: data.relabel ? [] : parseCues(row.gold_cues),
        noiseOnly: data.relabel ? false : Boolean(row.noise_only),
        skip: Boolean(row.skip),
        hasGold: Boolean(row.gold_text || row.gold_cues),
        hasRelabel: Boolean(row.relabel_gold_text || row.relabel_gold_cues),
      })),
    };
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
    if (!wav) return { ok: false as const, error: "没有这段录音。" };
    return { ok: true as const, audioBase64: wav, mimeType: "audio/wav" };
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
      await sql`
        update qingran_hearing_clips
        set gold_text = ${data.goldText ?? ""},
            gold_cues = ${JSON.stringify(cues)}::jsonb,
            noise_only = ${Boolean(data.noiseOnly)},
            skip = ${Boolean(data.skip)}
        where id = ${data.id}
      `;
    }
    return { ok: true as const };
  });

export const deleteHearingClip = createServerFn({ method: "POST" })
  .validator((input: { password: string; id: string }) => input)
  .handler(async ({ data }) => {
    assertLab(data.password);
    const sql = await getSql();
    await sql`delete from qingran_hearing_clips where id = ${data.id}`;
    return { ok: true as const };
  });

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
    }>`
      select id, created_at::text as created_at, duration_ms, source, category, split,
             xai_text, hearing_text, hearing_json, live_text,
             gold_text, gold_cues, noise_only, skip,
             relabel_gold_text, relabel_gold_cues, relabel_noise_only, audio_wav
      from qingran_hearing_clips
      order by created_at asc
    `;
    return {
      kind: "qingran-hearing-eval",
      version: 1,
      exportedAt: Date.now(),
      clips: rows.map((row) => ({
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
        audioBase64: row.audio_wav ?? "",
      })),
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

async function dispatchProvider(provider: HearingProviderId, audioBase64: string) {
  if (provider === "qwen") return hearWithQwen(audioBase64);
  if (provider === "gemini") return hearWithGemini(audioBase64);
  if (provider === "selfhost") return hearWithSelfhost(audioBase64);
  return xaiAsHearing("", 0);
}

async function upsertTurn(patch: HearingTurnPatch) {
  try {
    const sql = await getSql();
    await sql`
      insert into qingran_hearing_turns (
        id, provider, model, speech_start, endpoint_fired, upload_start, stt_done,
        grok_done, tts_first_audio, latency_ms, tokens_in, tokens_out, cost_usd,
        refusal, fallback, fallback_reason, cold_start_ms
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
        ${patch.cold_start_ms ?? null}
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
        cold_start_ms = coalesce(excluded.cold_start_ms, qingran_hearing_turns.cold_start_ms)
    `;
  } catch {
    /* preview without migration still runs */
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
}): Promise<string> {
  const id = newId();
  const sql = await getSql();
  const pathname = `hearing/${id}.wav`;
  await sql`
    insert into qingran_hearing_clips (
      id, duration_ms, sample_rate, source, category, blob_pathname, audio_wav,
      xai_text, hearing_text, hearing_json, live_text
    )
    values (
      ${id},
      ${input.durationMs},
      16000,
      ${input.source},
      ${input.category ?? null},
      ${pathname},
      ${input.audioBase64},
      ${input.xaiText},
      ${input.tagged},
      ${input.hearing ? JSON.stringify(input.hearing) : null}::jsonb,
      ${input.liveText}
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
