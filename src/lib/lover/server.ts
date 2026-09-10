import { createServerFn } from "@tanstack/react-start";
import { spokenForTts } from "./speech-tags";
import {
  isMostlyFiller,
  needsPunctuationHelp,
  restoreSpeechText,
  sttKeyterms,
  stripMarks,
} from "./stt-text";
import { ttsRequestBody } from "./tts";

const FAST_MODEL = "grok-4.20-0309-non-reasoning";

type TtsInput = {
  text: string;
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

    const res = await fetch("https://api.x.ai/v1/tts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(ttsRequestBody(text, "zh")),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      return { ok: false as const, error: `tts-${res.status}` };
    }

    const buf = Buffer.from(await res.arrayBuffer());
    return {
      ok: true as const,
      mimeType: res.headers.get("content-type") || "audio/pcm;rate=24000",
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
    form.append("filler_words", "true");
    form.append("vad_threshold", "0");
    for (const term of sttKeyterms(data.prompt)) form.append("keyterm", term);
    const blob = new Blob([new Uint8Array(bytes)], { type: mime });
    form.append("file", blob, filenameFor(mime));

    const res = await fetch("https://api.x.ai/v1/stt", {
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
    if (text && !isMostlyFiller(text)) text = await restorePunctuation(apiKey, text);
    return { ok: true as const, text, words: body.words ?? [] };
  });

async function restorePunctuation(apiKey: string, text: string): Promise<string> {
  if (!needsPunctuationHelp(text)) return text;
  try {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: FAST_MODEL,
        temperature: 0,
        max_tokens: 900,
        messages: [
          {
            role: "system",
            content:
              "只给中文口语补标点。只在句子真正说完时加句号或问号。不要密密麻麻加逗号，语气词后面不要加逗号。不要改字、删字、翻译或解释。只输出正文。",
          },
          { role: "user", content: text.slice(0, 1800) },
        ],
      }),
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return text;
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const next = (body.choices?.[0]?.message?.content ?? "").trim();
    if (!next) return text;
    if (stripMarks(next) !== stripMarks(text.slice(0, 1800))) return text;
    return next;
  } catch {
    return text;
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
