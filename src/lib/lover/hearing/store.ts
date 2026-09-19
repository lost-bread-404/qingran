import { createServerFn } from "@tanstack/react-start";
import { dbSource, getSql } from "@/lib/db";
import { newId } from "../storage";
import { HEARING, isHearingProvider, type HearingProviderId } from "./config.ts";
import {
  hearWithGemini,
  hearWithQwen,
  hearWithSelfhost,
  warmupSelfhost,
  clipFallbackRaw,
  type AdapterOutcome,
  type HearingCallOpts,
} from "./http.ts";
import { EMOTIONS, hearingCueSchema, type CueEmotion, type HearingCue, type HearingResult } from "./schema.ts";
import { assignSplits, hashSplit } from "./split.ts";
import { transcribeWithXai, xaiAsHearing } from "./xai.ts";
import { chooseHearing } from "./select.ts";
import { deleteHearingWav, putHearingWav, readHearingWav } from "./blob.ts";
import { isNoiseDisagreement, shouldDropAsNoise } from "./noise.ts";
import { goldTierFor, isGoldSource, type GoldSource } from "./gold.ts";
import type { AudioRoute, HearingMode } from "./route.ts";
import { errorText } from "./heard.ts";
import { envPresence } from "./env.ts";
import { scoreHearing, type ScoreWindow } from "./score.ts";
import {
  clipCount,
  clipLabelByTurn,
  confirmClipByTurn,
  exportReplyFlagDataset,
  goldCount,
  goldStatusByTurnIds,
  hallucinationCountByReason,
  insertClipRow,
  insertReplyFlag,
  listClipRows,
  listLabeledClipRows,
  listMigrationNames,
  listReplyFlagRows,
  listScoreClipRows,
  parseCues,
  patchFinalTextByTurn,
  patchReplyMessageId,
  unlabelClip,
  type LabClipFilter,
} from "./persist.ts";
import { silenceWavBase64, wavDurationMs, wavPeakRms } from "./wav.ts";
import { scrubHallucination } from "../stt-text.ts";
import { waitUntil } from "@vercel/functions";
import { gitCommitSha, hashQingranPrompt } from "./eval-meta.ts";
import {
  applyUtteranceTag,
  defaultTags,
  parseAcousticTags,
  parseTagKeys,
  tagsFromCues,
  type AcousticTags,
  type TagKey,
} from "./tags.ts";

export type { LabClipFilter, LabeledClipRow, ReplyFlagRow } from "./persist.ts";

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
  live_text_source?: string;
  hallucination_suspect?: boolean;
  save_error?: string;
  commit_sha?: string | null;
  prompt_hash?: string | null;
  context_before?: unknown;
  reply_message_id?: string | null;
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
  context?: string;
  nbest?: boolean;
  extraKeyterms?: string[];
  debugHearing?: boolean;
  mode?: HearingMode;
  audioRoute?: AudioRoute;
  peakRms?: number;
  vadFloor?: number;
  liveTextSource?: "webspeech" | "none";
  predictedTags?: AcousticTags;
  contextBefore?: { role: string; text: string }[];
  systemPrompt?: string;
  holdToTalk?: boolean;
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
  quota?: boolean;
  saveError?: string;
  hallucinationSuspect?: boolean;
  hallucinationReason?: "apple_empty" | "short_quiet";
  predictedTags?: AcousticTags;
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

export const hearingEnvStatus = createServerFn({ method: "GET" }).handler(async () => {
  const env = envPresence();
  return {
    ok: true as const,
    env,
    providers: {
      xai: env.XAI_API_KEY,
      qwen: env.DASHSCOPE_API_KEY,
      gemini: env.GEMINI_API_KEY,
      selfhost: env.SELFHOST_BASE_URL,
    },
  };
});

export const hearingLabDiagnostics = createServerFn({ method: "POST" })
  .validator((input: { password: string }) => input)
  .handler(async ({ data }) => {
    assertLab(data.password);
    try {
      const sql = await getSql();
      const migrations = await listMigrationNames(sql);
      const clips = await clipCount(sql);
      return {
        ok: true as const,
        dbSource,
        migrations,
        clipCount: clips,
        env: envPresence(),
      };
    } catch (err) {
      return {
        ok: false as const,
        dbSource,
        migrations: [] as string[],
        clipCount: 0,
        env: envPresence(),
        error: errorText(err),
      };
    }
  });

export const hearingConnectionTest = createServerFn({ method: "POST" })
  .validator((input: { password: string }) => input)
  .handler(async ({ data }) => {
    assertLab(data.password);
    const audioBase64 = silenceWavBase64(1);
    const env = envPresence();
    const ping = async (
      id: HearingProviderId,
      run: () => Promise<{ ok: boolean; latency_ms: number; error?: string }>,
    ) => {
      const started = Date.now();
      try {
        const result = await run();
        return { id, ...result };
      } catch (err) {
        return { id, ok: false, latency_ms: Date.now() - started, error: errorText(err) };
      }
    };
    const engines = await Promise.all([
      ping("xai", async () => {
        const result = await transcribeWithXai({ audioBase64, mimeType: "audio/wav" });
        return result.ok
          ? { ok: true, latency_ms: result.latency_ms }
          : { ok: false, latency_ms: result.latency_ms, error: result.error };
      }),
      ping("qwen", async () => {
        const result = await hearWithQwen(audioBase64);
        return result.ok
          ? { ok: true, latency_ms: result.result.latency_ms }
          : { ok: false, latency_ms: result.latency_ms, error: result.raw || result.reason };
      }),
      ping("gemini", async () => {
        const result = await hearWithGemini(audioBase64);
        return result.ok
          ? { ok: true, latency_ms: result.result.latency_ms }
          : { ok: false, latency_ms: result.latency_ms, error: result.raw || result.reason };
      }),
      ping("selfhost", async () => {
        const result = await hearWithSelfhost(audioBase64);
        return result.ok
          ? { ok: true, latency_ms: result.result.latency_ms }
          : { ok: false, latency_ms: result.latency_ms, error: result.raw || result.reason };
      }),
    ]);
    let migrations: string[] = [];
    let clips = 0;
    let dbError: string | undefined;
    try {
      const sql = await getSql();
      migrations = await listMigrationNames(sql);
      clips = await clipCount(sql);
    } catch (err) {
      dbError = errorText(err);
    }
    return {
      ok: true as const,
      env,
      engines,
      dbSource,
      migrations,
      clipCount: clips,
      dbError,
    };
  });

export const hearingTurnMeta = createServerFn({ method: "POST" })
  .validator((input: { turnIds: string[] }) => input)
  .handler(async ({ data }) => {
    const sql = await getSql();
    const rows = await goldStatusByTurnIds(sql, data.turnIds.slice(0, 80));
    return { ok: true as const, turns: rows };
  });

export const getHearingTurnAudio = createServerFn({ method: "POST" })
  .validator((input: { turnId: string }) => input)
  .handler(async ({ data }) => {
    const sql = await getSql();
    const rows = await sql<{ audio_wav: string | null; blob_pathname: string | null }>`
      select audio_wav, blob_pathname from qingran_hearing_clips
      where turn_id = ${data.turnId}
      order by created_at desc
      limit 1
    `;
    const wav = rows[0]?.audio_wav;
    if (wav) return { ok: true as const, audioBase64: wav, mimeType: "audio/wav" };
    const fromBlob = rows[0]?.blob_pathname ? await readHearingWav(rows[0].blob_pathname) : null;
    if (!fromBlob) return { ok: false as const, error: "没有这段录音。" };
    return { ok: true as const, audioBase64: fromBlob, mimeType: "audio/wav" };
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

    const { used, hearing, words, refusal } = picked;
    let fallback = picked.fallback;
    let fallbackReason: string | undefined = picked.fallback_reason;
    const originalXai = picked.xaiText;
    let xaiText = originalXai;
    const durationSec = wavDurationMs(data.audioBase64) / 1000;
    const peakRms = wavPeakRms(data.audioBase64);
    const liveText = data.liveText ?? "";
    const holdToTalk = Boolean(data.holdToTalk) || data.mode === "text";
    const scrubbed = scrubHallucination(originalXai, { durationSec, peakRms }, liveText, { holdToTalk });
    if (scrubbed.suspect) {
      fallback = true;
      fallbackReason = scrubbed.reason;
    } else if (scrubbed.reason === "prefer_apple_quiet") {
      fallback = true;
      fallbackReason = "prefer_apple_quiet";
      xaiText = originalXai;
    }
    const providerNoise = Boolean(hearing?.noise_only && used !== "xai");
    const disagreement = isNoiseDisagreement(providerNoise, xaiText);
    const drop = shouldDropAsNoise(providerNoise, xaiText) || scrubbed.suspect;
    const predicted =
      used !== "xai" && hearing?.cues?.length
        ? tagsFromCues(hearing.cues)
        : parseAcousticTags(data.predictedTags) ?? defaultTags();
    const taggedCore = drop
      ? ""
      : scrubbed.reason === "prefer_apple_quiet"
        ? liveText
        : disagreement
          ? xaiText
          : used === "xai"
            ? xaiText
            : picked.tagged;
    const tagged = taggedCore ? applyUtteranceTag(taggedCore, predicted) : "";
    const stt_done = Date.now();
    const latency_ms = hearing?.latency_ms ?? (xai.ok ? xai.latency_ms : 0);
    const model = hearing?.model || HEARING[used].model;
    const commitSha = gitCommitSha() || null;
    const promptHash = data.systemPrompt ? hashQingranPrompt(data.systemPrompt) : null;

    waitUntil(
      persistHearingTurn({
        turnId,
        used,
        model,
        data,
        upload_start,
        stt_done,
        latency_ms,
        hearing,
        xaiText,
        pickedXaiText: originalXai,
        tagged,
        predictedTags: predicted,
        commitSha,
        promptHash,
        fallback,
        fallbackReason,
        outcome,
        scrubbedSuspect: scrubbed.suspect,
        disagreement,
        durationMs: Math.round(durationSec * 1000),
        peakRms: data.peakRms ?? peakRms,
        capture: Boolean(data.capture || data.debugHearing),
        refusal,
      }),
    );

    return {
      ok: true,
      turnId,
      provider: used,
      model,
      tagged,
      text: hearing?.text ?? xaiText,
      xaiText: originalXai,
      liveText: data.liveText ?? "",
      noise_only: drop,
      disagreement,
      fallback,
      fallback_reason: fallbackReason,
      refusal,
      latency_ms,
      words,
      hearing,
      hallucinationSuspect: scrubbed.suspect,
      hallucinationReason: scrubbed.suspect && (scrubbed.reason === "apple_empty" || scrubbed.reason === "short_quiet")
        ? scrubbed.reason
        : undefined,
      predictedTags: predicted,
    };
  });

export const hearingLabeledCount = createServerFn({ method: "POST" })
  .validator((input: Record<string, never> = {}) => input)
  .handler(async () => {
    try {
      const sql = await getSql();
      return { ok: true as const, count: await goldCount(sql) };
    } catch (err) {
      return { ok: false as const, error: errorText(err), count: 0 };
    }
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

export const patchHearingFinalText = createServerFn({ method: "POST" })
  .validator((input: { turnId: string; finalText: string }) => input)
  .handler(async ({ data }) => {
    try {
      const sql = await getSql();
      await patchFinalTextByTurn(sql, data.turnId, data.finalText);
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: errorText(err) };
    }
  });

export const patchHearingReplyId = createServerFn({ method: "POST" })
  .validator((input: { turnId: string; replyMessageId: string }) => input)
  .handler(async ({ data }) => {
    try {
      const sql = await getSql();
      await patchReplyMessageId(sql, data.turnId, data.replyMessageId);
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: errorText(err) };
    }
  });

export const getHearingClipLabel = createServerFn({ method: "POST" })
  .validator((input: { turnId: string }) => input)
  .handler(async ({ data }) => {
    try {
      const sql = await getSql();
      const row = await clipLabelByTurn(sql, data.turnId);
      if (!row) return { ok: false as const, error: "没有这段录音。" };
      return { ok: true as const, ...row };
    } catch (err) {
      return { ok: false as const, error: errorText(err) };
    }
  });

export const flagQingranReply = createServerFn({ method: "POST" })
  .validator((input: { messageId: string; replyToMessageId?: string | null; note: string }) => input)
  .handler(async ({ data }) => {
    try {
      const sql = await getSql();
      const [profileRow] = await sql<{ data: { systemPrompt?: string } | string }>`
        select data from qingran_profile where id = 1
      `;
      const raw = profileRow?.data;
      const stored = typeof raw === "string" ? (safeJson(raw) as { systemPrompt?: string } | null) : raw;
      await insertReplyFlag(sql, {
        id: newId(),
        messageId: data.messageId,
        replyToMessageId: data.replyToMessageId ?? null,
        note: data.note.trim().slice(0, 200),
        commitSha: gitCommitSha() || null,
        promptHash: hashQingranPrompt(stored?.systemPrompt || ""),
      });
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: errorText(err) };
    }
  });

export const listReplyFlags = createServerFn({ method: "POST" })
  .validator((input: { password: string }) => input)
  .handler(async ({ data }) => {
    try {
      assertLab(data.password);
      const sql = await getSql();
      return { ok: true as const, flags: await listReplyFlagRows(sql) };
    } catch (err) {
      return { ok: false as const, error: errorText(err), flags: [] as Awaited<ReturnType<typeof listReplyFlagRows>> };
    }
  });

export const exportReplyFlags = createServerFn({ method: "POST" })
  .validator((input: { password: string }) => input)
  .handler(async ({ data }) => {
    assertLab(data.password);
    const sql = await getSql();
    return exportReplyFlagDataset(await listReplyFlagRows(sql));
  });

export const confirmHearingClip = createServerFn({ method: "POST" })
  .validator(
    (input: {
      turnId: string;
      goldText: string;
      goldSource: GoldSource;
      utteranceEmotion?: string | null;
      noiseOnly?: boolean;
      literalMismatch?: boolean;
      toneNote?: string | null;
      goldTags?: Partial<AcousticTags> | null;
      tagsTouched?: TagKey[] | null;
    }) => input,
  )
  .handler(async ({ data }) => {
    try {
      const sql = await getSql();
      return await confirmClipByTurn(sql, {
        turnId: data.turnId,
        goldText: data.goldText,
        goldSource: data.goldSource,
        utteranceEmotion: data.utteranceEmotion,
        noiseOnly: data.noiseOnly,
        literalMismatch: data.literalMismatch,
        toneNote: data.toneNote,
        goldTags: data.goldTags,
        tagsTouched: data.tagsTouched,
      });
    } catch (err) {
      return { ok: false as const, error: errorText(err) };
    }
  });

export const unlabelHearingClip = createServerFn({ method: "POST" })
  .validator((input: { password: string; id: string }) => input)
  .handler(async ({ data }) => {
    try {
      assertLab(data.password);
      const sql = await getSql();
      return await unlabelClip(sql, { clipId: data.id });
    } catch (err) {
      return { ok: false as const, error: errorText(err) };
    }
  });

export const unlabelHearingByTurn = createServerFn({ method: "POST" })
  .validator((input: { turnId: string }) => input)
  .handler(async ({ data }) => {
    try {
      const sql = await getSql();
      return await unlabelClip(sql, { turnId: data.turnId });
    } catch (err) {
      return { ok: false as const, error: errorText(err) };
    }
  });

export const listLabeledHearingClips = createServerFn({ method: "POST" })
  .validator((input: { password: string; page?: number }) => input)
  .handler(async ({ data }) => {
    try {
      assertLab(data.password);
      const sql = await getSql();
      const listed = await listLabeledClipRows(sql, data.page ?? 1);
      return { ok: true as const, ...listed };
    } catch (err) {
      return {
        ok: false as const,
        error: errorText(err),
        clips: [] as Awaited<ReturnType<typeof listLabeledClipRows>>["clips"],
        total: 0,
        page: 1,
        pageSize: 30,
      };
    }
  });

export const listHearingClips = createServerFn({ method: "POST" })
  .validator((input: { password: string; relabel?: boolean; filter?: LabClipFilter }) => input)
  .handler(async ({ data }) => {
    try {
      assertLab(data.password);
      const sql = await getSql();
      const filter = data.filter ?? "all";
      const rows = await listClipRows(sql, filter);
      return {
        ok: true as const,
        clips: rows.map((row) => mapClipRow(row, data.relabel)),
      };
    } catch (err) {
      return { ok: false as const, error: errorText(err), clips: [] as ReturnType<typeof mapClipRow>[] };
    }
  });

export const hearingLabScore = createServerFn({ method: "POST" })
  .validator((input: { password: string; window?: ScoreWindow }) => input)
  .handler(async ({ data }) => {
    const window: ScoreWindow = data.window === "7d" ? "7d" : "all";
    try {
      assertLab(data.password);
      const sql = await getSql();
      const rows = await listScoreClipRows(sql);
      const hallucinationByReason = await hallucinationCountByReason(sql, window);
      const hallucinationN = hallucinationByReason.apple_empty + hallucinationByReason.short_quiet;
      const score = scoreHearing(
        rows.map((row) => ({
          id: row.id,
          createdAt: row.created_at,
          finalText: row.final_text ?? "",
          xaiText: row.xai_text ?? "",
          liveText: row.live_text ?? "",
          goldText: row.gold_text ?? "",
          noiseOnly: Boolean(row.noise_only),
          utteranceEmotion: row.utterance_emotion,
          literalMismatch: Boolean(row.literal_mismatch),
          toneNote: row.tone_note,
          turnId: row.turn_id,
          predictedTags: parseAcousticTags(row.predicted_tags),
          goldTags:
            row.gold_tags && typeof row.gold_tags === "object"
              ? (row.gold_tags as Partial<AcousticTags>)
              : null,
          tagsTouched: parseTagKeys(row.tags_touched),
        })),
        { window, hallucinationN, hallucinationByReason },
      );
      return { ok: true as const, dbSource, window, ...score };
    } catch (err) {
      return {
        ok: false as const,
        error: errorText(err),
        dbSource,
        window,
        ...scoreHearing([], { window, hallucinationN: 0 }),
      };
    }
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
    try {
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
    } catch (err) {
      return { ok: false as const, error: errorText(err) };
    }
  });

export const deleteHearingClip = createServerFn({ method: "POST" })
  .validator((input: { password: string; id: string }) => input)
  .handler(async ({ data }) => {
    assertLab(data.password);
    const sql = await getSql();
    const rows = await sql<{ blob_pathname: string | null }>`
      select blob_pathname from qingran_hearing_clips where id = ${data.id}
    `;
    await deleteHearingWav(rows[0]?.blob_pathname);
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
      blob_pathname: string | null;
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
      final_text: string | null;
      peak_rms: number | null;
      vad_floor: number | null;
      predicted_tags: unknown;
      gold_tags: unknown;
      tags_touched: string[] | null;
      commit_sha: string | null;
      prompt_hash: string | null;
      context_before: unknown;
      reply_message_id: string | null;
    }>`
      select id, created_at::text as created_at, duration_ms, source, category, split,
             xai_text, hearing_text, hearing_json, live_text,
             gold_text, gold_cues, noise_only, skip,
             relabel_gold_text, relabel_gold_cues, relabel_noise_only, audio_wav, blob_pathname,
             gold_source, stt_text, gold_tier, utterance_emotion, literal_mismatch, tone_note,
             mode, audio_route,
             turn_id, disagreement, storage_backend, final_text, peak_rms, vad_floor,
             predicted_tags, gold_tags, tags_touched, commit_sha, prompt_hash, context_before, reply_message_id
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
          split: hashSplit(row.id),
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
          literalMismatch: Boolean(row.literal_mismatch),
          toneNote: row.tone_note,
          mode: row.mode,
          audioRoute: row.audio_route,
          turnId: row.turn_id,
          disagreement: Boolean(row.disagreement),
          storageBackend: row.storage_backend,
          finalText: row.final_text ?? "",
          peakRms: row.peak_rms,
          vadFloor: row.vad_floor,
          predictedTags: parseAcousticTags(row.predicted_tags),
          goldTags:
            row.gold_tags && typeof row.gold_tags === "object"
              ? (row.gold_tags as Partial<AcousticTags>)
              : null,
          tagsTouched: parseTagKeys(row.tags_touched),
          commitSha: row.commit_sha,
          promptHash: row.prompt_hash,
          contextBefore: Array.isArray(row.context_before)
            ? (row.context_before as { role: string; text: string }[])
            : null,
          replyMessageId: row.reply_message_id,
        })),
      ),
    };
  });

async function dispatchProvider(provider: HearingProviderId, audioBase64: string, opts?: HearingCallOpts) {
  if (provider === "qwen") return hearWithQwen(audioBase64, opts);
  if (provider === "gemini") return hearWithGemini(audioBase64, opts);
  if (provider === "selfhost") return hearWithSelfhost(audioBase64, opts);
  return xaiAsHearing("", 0);
}

async function persistHearingTurn(input: {
  turnId: string;
  used: HearingProviderId;
  model: string;
  data: RunHearingInput;
  upload_start: number;
  stt_done: number;
  latency_ms: number;
  hearing: HearingResult | null;
  xaiText: string;
  pickedXaiText: string;
  tagged: string;
  predictedTags?: AcousticTags | null;
  commitSha?: string | null;
  promptHash?: string | null;
  fallback: boolean;
  fallbackReason?: string;
  outcome: AdapterOutcome | null;
  scrubbedSuspect: boolean;
  disagreement: boolean;
  durationMs: number;
  peakRms: number;
  capture: boolean;
  refusal: boolean;
}) {
  await upsertTurn({
    id: input.turnId,
    provider: input.used,
    model: input.model,
    speech_start: input.data.speech_start,
    endpoint_fired: input.data.endpoint_fired,
    upload_start: input.upload_start,
    stt_done: input.stt_done,
    latency_ms: input.latency_ms,
    tokens_in: input.hearing?.tokens_in,
    tokens_out: input.hearing?.tokens_out,
    cost_usd: input.hearing?.cost_usd,
    refusal: input.refusal,
    fallback: input.fallback,
    fallback_reason: input.fallbackReason,
    fallback_raw: input.scrubbedSuspect || input.fallbackReason === "prefer_apple_quiet"
      ? clipFallbackRaw(input.pickedXaiText)
      : clipFallbackRaw(input.outcome && !input.outcome.ok ? input.outcome.raw : undefined),
    disagreement: input.disagreement,
    live_text_source: input.data.liveTextSource ?? (input.data.liveText?.trim() ? "webspeech" : "none"),
    hallucination_suspect: input.scrubbedSuspect,
    commit_sha: input.commitSha,
    prompt_hash: input.promptHash,
    context_before: input.data.contextBefore,
  });
  if (!input.capture) return;
  try {
    await insertClip({
      audioBase64: input.data.audioBase64,
      durationMs: input.durationMs,
      source: input.data.source === "scripted" ? "scripted" : "real",
      category: input.data.category,
      xaiText: input.xaiText,
      hearing: input.hearing,
      tagged: input.tagged,
      liveText: input.data.liveText ?? "",
      turnId: input.turnId,
      mode: input.data.mode,
      audioRoute: input.data.audioRoute,
      disagreement: input.disagreement,
      peakRms: input.peakRms,
      vadFloor: input.data.vadFloor,
      predictedTags: input.predictedTags,
      commitSha: input.commitSha,
      promptHash: input.promptHash,
      contextBefore: input.data.contextBefore,
      hallucinationSuspect: input.scrubbedSuspect,
    });
  } catch (err) {
    const saveError = errorText(err);
    console.error("[hearing] insertClip failed:", saveError);
    await upsertTurn({ id: input.turnId, save_error: saveError });
  }
}

async function upsertTurn(patch: HearingTurnPatch) {
  try {
    const sql = await getSql();
    await sql`
      insert into qingran_hearing_turns (
        id, provider, model, speech_start, endpoint_fired, upload_start, stt_done,
        grok_done, tts_first_audio, latency_ms, tokens_in, tokens_out, cost_usd,
        refusal, fallback, fallback_reason, fallback_raw, cold_start_ms, disagreement,
        live_text_source, hallucination_suspect, save_error,
        commit_sha, prompt_hash, context_before, reply_message_id
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
        ${Boolean(patch.disagreement)},
        ${patch.live_text_source ?? null},
        ${Boolean(patch.hallucination_suspect)},
        ${patch.save_error ?? null},
        ${patch.commit_sha ?? null},
        ${patch.prompt_hash ?? null},
        ${patch.context_before ? JSON.stringify(patch.context_before) : null}::jsonb,
        ${patch.reply_message_id ?? null}
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
        disagreement = excluded.disagreement or qingran_hearing_turns.disagreement,
        live_text_source = coalesce(excluded.live_text_source, qingran_hearing_turns.live_text_source),
        hallucination_suspect = excluded.hallucination_suspect or qingran_hearing_turns.hallucination_suspect,
        save_error = coalesce(excluded.save_error, qingran_hearing_turns.save_error),
        commit_sha = coalesce(excluded.commit_sha, qingran_hearing_turns.commit_sha),
        prompt_hash = coalesce(excluded.prompt_hash, qingran_hearing_turns.prompt_hash),
        context_before = coalesce(excluded.context_before, qingran_hearing_turns.context_before),
        reply_message_id = coalesce(excluded.reply_message_id, qingran_hearing_turns.reply_message_id)
    `;
  } catch (err) {
    console.error("[hearing] upsertTurn failed:", errorText(err));
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
  peakRms?: number | null;
  vadFloor?: number | null;
  predictedTags?: AcousticTags | null;
  commitSha?: string | null;
  promptHash?: string | null;
  contextBefore?: unknown;
  hallucinationSuspect?: boolean;
}): Promise<string> {
  const id = newId();
  const sql = await getSql();
  const bytes = Buffer.from(input.audioBase64, "base64");
  const stored = await putHearingWav(id, bytes);
  const storedPath = stored.pathname;
  const blobError = stored.error;
  const storageBackend = storedPath ? "blob" : "db";
  const audioWav = storedPath ? null : input.audioBase64;
  const sttText = input.xaiText || input.tagged;
  await insertClipRow(sql, {
    id,
    durationMs: input.durationMs,
    source: input.source,
    category: input.category,
    blobPathname: storedPath,
    audioWav,
    xaiText: input.xaiText,
    hearingText: input.tagged,
    hearingJson: input.hearing ? JSON.stringify(input.hearing) : null,
    liveText: input.liveText,
    blobError,
    storageBackend,
    sttText,
    mode: input.mode,
    audioRoute: input.audioRoute,
    turnId: input.turnId,
    disagreement: input.disagreement,
    finalText: input.hallucinationSuspect ? "" : input.tagged || input.xaiText || "",
    peakRms: input.peakRms,
    vadFloor: input.vadFloor,
    predictedTags: input.predictedTags,
    commitSha: input.commitSha,
    promptHash: input.promptHash,
    contextBefore: input.contextBefore,
  });
  return id;
}

function asHearing(value: unknown): HearingResult | null {
  if (!value || typeof value !== "object") return null;
  return value as HearingResult;
}

function isEmotion(value: unknown): value is CueEmotion {
  return typeof value === "string" && (EMOTIONS as readonly string[]).includes(value);
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
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
    literal_mismatch?: boolean | null;
    tone_note?: string | null;
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
    literalMismatch: relabel ? false : Boolean(row.literal_mismatch),
    toneNote: relabel ? null : row.tone_note ?? null,
    mode: row.mode,
    audioRoute: row.audio_route,
    turnId: row.turn_id,
    disagreement: Boolean(row.disagreement),
    storageBackend: row.storage_backend,
    blobError: row.blob_error,
  };
}
