import { restoreSpeechText } from "../stt-text.ts";
import { isQuotaHint, readXaiFail } from "../xai-error.ts";
import { HEARING, STT_KEYTERMS, xaiVadThreshold } from "./config.ts";
import { xaiFetch } from "../xai-auth.ts";

export type SttWord = { text?: string; start?: number; end?: number };

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

/** Her list (or the built-in one) first, then the context's: at most 100, each at most 50 characters, as xAI takes them. */
export function keytermList(keyterms?: readonly string[], extra?: readonly string[]): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const term of [...(keyterms ?? STT_KEYTERMS), ...(extra ?? [])]) {
    const next = term.trim().slice(0, 50);
    if (!next || seen.has(next)) continue;
    seen.add(next);
    terms.push(next);
    if (terms.length >= 100) break;
  }
  return terms;
}

/** xAI's words as text, the same way whether they came back from one clip or streamed while she spoke. */
export function xaiResult(raw: string, words: SttWord[], latency_ms: number): XaiStt {
  let text = restoreSpeechText(raw, words);
  if (!text) text = restoreSpeechText(words.map((w) => w.text ?? "").join("").trim());
  return { ok: true, text, words, latency_ms, raw };
}

export async function transcribeWithXai(input: {
  audioBase64: string;
  mimeType: string;
  prompt?: string;
  extraKeyterms?: string[];
  keyterms?: readonly string[];
}): Promise<XaiStt | XaiSttFail> {
  const started = Date.now();
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
  for (const term of keytermList(input.keyterms, input.extraKeyterms)) {
    form.append("keyterm", term);
  }
  const blob = new Blob([new Uint8Array(bytes)], { type: mime });
  form.append("file", blob, filenameFor(mime));

  try {
    const sent = await xaiFetch(HEARING.xai.sttUrl, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!sent) return { ok: false, error: "stt-unavailable", latency_ms: Date.now() - started };
    const res = sent.res;
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
    return xaiResult(body.text || body.transcript || "", body.words ?? [], latency_ms);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "stt-unavailable",
      latency_ms: Date.now() - started,
    };
  }
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
