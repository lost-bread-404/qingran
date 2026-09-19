import { restoreSpeechText, STT_KEYTERMS } from "../stt-text.ts";
import { isQuotaHint, readXaiFail } from "../xai-error.ts";
import { HEARING, xaiVadThreshold } from "./config.ts";
import type { AdapterOutcome } from "./http.ts";

type SttWord = { text?: string; start?: number; end?: number };

export type XaiStt = {
  ok: true;
  text: string;
  words: SttWord[];
  latency_ms: number;
  raw: string;
};

export type XaiSttFail = {
  ok: false;
  error: string;
  latency_ms: number;
  quota?: boolean;
};

export async function transcribeWithXai(input: {
  audioBase64: string;
  mimeType: string;
  prompt?: string;
  extraKeyterms?: string[];
}): Promise<XaiStt | XaiSttFail> {
  const started = Date.now();
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "stt-unavailable", latency_ms: 0 };
  }
  const mime = sanitizeMime(input.mimeType);
  const bytes = Buffer.from(input.audioBase64, "base64");
  if (bytes.length < 20) return { ok: false, error: "太短了。", latency_ms: Date.now() - started };
  if (bytes.length > 12_000_000) {
    return { ok: false, error: "这段有点太长。", latency_ms: Date.now() - started };
  }

  const form = new FormData();
  form.append("model", HEARING.xai.model);
  form.append("filler_words", "true");
  form.append("vad_threshold", String(xaiVadThreshold()));
  for (const term of STT_KEYTERMS) {
    form.append("keyterm", term);
  }
  const blob = new Blob([new Uint8Array(bytes)], { type: mime });
  form.append("file", blob, filenameFor(mime));

  try {
    const res = await fetch(HEARING.xai.sttUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    const latency_ms = Date.now() - started;
    if (!res.ok) {
      const hint = await readXaiFail(res);
      return {
        ok: false,
        error: isQuotaHint(hint) ? hint : `没听清（${res.status}）。`,
        latency_ms,
        quota: isQuotaHint(hint),
      };
    }
    const body = (await res.json()) as {
      text?: string;
      transcript?: string;
      words?: SttWord[];
    };
    const raw = body.text || body.transcript || "";
    let text = restoreSpeechText(raw, body.words);
    if (!text) {
      const fallback = (body.words ?? []).map((w) => w.text ?? "").join("").trim();
      text = restoreSpeechText(fallback);
    }
    return { ok: true, text, words: body.words ?? [], latency_ms, raw };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "stt-unavailable",
      latency_ms: Date.now() - started,
    };
  }
}

export function xaiAsHearing(text: string, latency_ms: number, raw = ""): AdapterOutcome {
  return {
    ok: true,
    result: {
      text,
      cues: [],
      utterance_emotion: "neutral",
      noise_only: !text.trim(),
      raw,
      latency_ms,
      provider: "xai",
      model: HEARING.xai.model,
      refusal: false,
    },
  };
}

function sanitizeMime(mime: string): string {
  const base = mime.split(";")[0]?.trim().toLowerCase() || "audio/webm";
  const allowed = new Set([
    "audio/webm",
    "audio/mp4",
    "audio/mpeg",
    "audio/wav",
    "audio/ogg",
    "audio/mp3",
    "audio/x-m4a",
    "audio/aac",
    "audio/flac",
  ]);
  return allowed.has(base) ? base : "audio/webm";
}

function filenameFor(mime: string): string {
  if (mime.includes("mp4") || mime.includes("m4a")) return "clip.mp4";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "clip.mp3";
  if (mime.includes("wav")) return "clip.wav";
  if (mime.includes("ogg")) return "clip.ogg";
  return "clip.webm";
}
