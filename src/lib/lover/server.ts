import { createServerFn } from "@tanstack/react-start";
import { spokenForTts } from "./speech-tags";
import { restoreSpeechText } from "./stt-text";
import { ttsRequestBody, ttsSpeed } from "./tts";
import { isQuotaHint, readXaiFail } from "./xai-error";
import { HEARING, STT_KEYTERMS, xaiVadThreshold } from "./hearing/config";
import { recordSttSpend, recordTtsSpend } from "./brain/spend/check";
import { VOICE_IO } from "./brain/config";

type TtsInput = {
  text: string;
  speed?: number;
};

type SttInput = {
  audioBase64: string;
  mimeType: string;
  prompt?: string;
};

export const speakAsLover = createServerFn({ method: "POST" })
  .validator((input: TtsInput) => input)
  .handler(async ({ data }) => {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) return { ok: false as const, error: "voice-unavailable" };

    const text = spokenForTts(data.text.trim());
    if (!text) return { ok: false as const, error: "empty" };

    const res = await fetch(VOICE_IO.ttsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(ttsRequestBody(text, VOICE_IO.language, ttsSpeed(data.speed ?? 1))),
      signal: AbortSignal.timeout(40_000),
    });

    if (!res.ok) {
      return { ok: false as const, error: await readXaiFail(res) };
    }

    const buf = Buffer.from(await res.arrayBuffer());
    void recordTtsSpend(text.length);
    return {
      ok: true as const,
      mimeType: res.headers.get("content-type") || `audio/pcm;rate=${VOICE_IO.sampleRate}`,
      audioBase64: buf.toString("base64"),
    };
  });

export async function transcribeVoiceAudio(data: SttInput) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return { ok: false as const, error: "stt-unavailable" };

  const mime = sanitizeMime(data.mimeType);
  const bytes = Buffer.from(data.audioBase64, "base64");
  if (bytes.length < 20) return { ok: false as const, error: "太短了。" };
  if (bytes.length > 12_000_000) return { ok: false as const, error: "这段有点太长。" };

  const form = new FormData();
  form.append("model", HEARING.xai.model);
  form.append("filler_words", "true");
  form.append("vad_threshold", String(xaiVadThreshold()));
  for (const term of STT_KEYTERMS) form.append("keyterm", term);
  const blob = new Blob([new Uint8Array(bytes)], { type: mime });
  form.append("file", blob, filenameFor(mime));

  const res = await fetch("https://api.x.ai/v1/stt", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const hint = await readXaiFail(res);
    return { ok: false as const, error: isQuotaHint(hint) ? hint : `没听清（${res.status}）。` };
  }

  const body = (await res.json()) as {
    text?: string;
    transcript?: string;
    words?: { text?: string; start?: number; end?: number }[];
  };
  const raw = body.text || body.transcript || "";
  let text = restoreSpeechText(raw, body.words);
  if (!text) {
    const fallback = (body.words ?? []).map((w) => w.text ?? "").join("").trim();
    text = restoreSpeechText(fallback);
  }
  const lastEnd = (body.words ?? []).reduce((m, w) => Math.max(m, Number(w.end) || 0), 0);
  const seconds = lastEnd > 0 ? lastEnd : bytes.length / (VOICE_IO.sampleRate * 2);
  void recordSttSpend(seconds, false);
  return { ok: true as const, text, words: body.words ?? [] };
}

export const transcribeVoice = createServerFn({ method: "POST" })
  .validator((input: SttInput) => input)
  .handler(async ({ data }) => transcribeVoiceAudio(data));

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
