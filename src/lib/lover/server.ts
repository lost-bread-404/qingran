import { createServerFn } from "@tanstack/react-start";
import { VOICE_IO } from "./brain/config";
import { spokenForTts } from "./speech-tags";
import { restoreSpeechText, sttKeyterms } from "./stt-text";
import { ttsRequestBody, ttsSpeed } from "./tts";

type TtsInput = {
  text: string;
  softVoice?: boolean;
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
      body: JSON.stringify(ttsRequestBody(text, VOICE_IO.language, ttsSpeed(Boolean(data.softVoice)))),
      signal: AbortSignal.timeout(40_000),
    });

    if (!res.ok) {
      return { ok: false as const, error: `tts-${res.status}` };
    }

    const buf = Buffer.from(await res.arrayBuffer());
    return {
      ok: true as const,
      mimeType: res.headers.get("content-type") || `audio/pcm;rate=${VOICE_IO.sampleRate}`,
      audioBase64: buf.toString("base64"),
    };
  });

export const transcribeVoice = createServerFn({ method: "POST" })
  .validator((input: SttInput) => input)
  .handler(async ({ data }) => {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) return { ok: false as const, error: "stt-unavailable" };

    const mime = sanitizeMime(data.mimeType);
    const bytes = Buffer.from(data.audioBase64, "base64");
    if (bytes.length < 20) return { ok: false as const, error: "太短了。" };
    if (bytes.length > 12_000_000) return { ok: false as const, error: "这段有点太长。" };

    const form = new FormData();
    form.append("language", "zh");
    form.append("filler_words", "true");
    form.append("vad_threshold", "0");
    form.append(
      "prompt",
      "中文口语原文。嗯、啊、呜、哈照实写，不要省略语气词，不要翻译。",
    );
    for (const term of sttKeyterms(data.prompt)) form.append("keyterm", term);
    const blob = new Blob([new Uint8Array(bytes)], { type: mime });
    form.append("file", blob, filenameFor(mime));

    const res = await fetch(VOICE_IO.sttUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      return { ok: false as const, error: `没听清（${res.status}）。` };
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
    return { ok: true as const, text, words: body.words ?? [] };
  });

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
