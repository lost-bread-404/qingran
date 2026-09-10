import { createServerFn } from "@tanstack/react-start";
import {
  buildConsolidatePrompt,
  buildOverflowRememberPrompt,
  buildRememberPrompt,
  formatClock,
  parseConsolidateResult,
  parseOverflowResult,
  parseRememberResult,
} from "./prompt";
import { spokenForTts } from "./speech-tags";
import {
  isMostlyFiller,
  needsPunctuationHelp,
  restoreSpeechText,
  sttKeyterms,
  stripMarks,
} from "./stt-text";
import { ttsRequestBody } from "./tts";
import type { ChatMessage, Memory } from "./types";

const FAST_MODEL = "grok-4.20-0309-non-reasoning";

type TtsInput = {
  text: string;
};

type SttInput = {
  audioBase64: string;
  mimeType: string;
  prompt?: string;
};

type RememberInput = {
  stretch: string;
  memories: Memory[];
};

type OverflowInput = {
  overflow: ChatMessage[];
  lookahead: ChatMessage[];
  memories: Memory[];
};

export const rememberTurn = createServerFn({ method: "POST" })
  .validator((input: RememberInput) => input)
  .handler(async ({ data }) => {
    const empty = { facts: [] as string[], events: [] as string[] };
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) return { ok: true as const, ...empty };

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
          max_tokens: 120,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "user",
              content: buildRememberPrompt(data.stretch, data.memories),
            },
          ],
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return { ok: true as const, ...empty };
      const body = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const parsed = parseRememberResult(body.choices?.[0]?.message?.content ?? "");
      return { ok: true as const, facts: parsed.facts, events: parsed.facts };
    } catch {
      return { ok: true as const, ...empty };
    }
  });

export const rememberOverflow = createServerFn({ method: "POST" })
  .validator((input: OverflowInput) => input)
  .handler(async ({ data }) => {
    const overflow = Array.isArray(data.overflow) ? data.overflow.slice(0, 24) : [];
    if (overflow.length === 0) {
      return { consumedIds: [] as string[], fact: "" };
    }
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
      return { consumedIds: overflow.map((m) => m.id), fact: "" };
    }
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
          max_tokens: 180,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "user",
              content: buildOverflowRememberPrompt(
                overflow,
                data.lookahead.slice(0, 10),
                data.memories,
              ),
            },
          ],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { consumedIds: overflow.map((m) => m.id), fact: "" };
      const body = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const parsed = parseOverflowResult(
        body.choices?.[0]?.message?.content ?? "",
        overflow.length,
      );
      const consumedIds = overflow.slice(0, Math.max(parsed.consumed, 1)).map((m) => m.id);
      return { consumedIds, fact: parsed.fact, at: overflow[0]?.createdAt || Date.now() };
    } catch {
      return { consumedIds: overflow.map((m) => m.id), fact: "" };
    }
  });

export const consolidateMemories = createServerFn({ method: "POST" })
  .validator((input: { memories: Memory[]; nowMs?: number; timeZone?: string }) => input)
  .handler(async ({ data }) => {
    const memories = Array.isArray(data.memories) ? data.memories.slice(0, 80) : [];
    if (memories.length === 0) return { ok: true as const, facts: [] as Array<{ text: string; createdAt?: number }> };
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) return { ok: false as const, facts: [] as Array<{ text: string; createdAt?: number }> };
    try {
      const clock = formatClock(data.nowMs || Date.now(), data.timeZone || "UTC");
      const res = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: FAST_MODEL,
          temperature: 0.2,
          max_tokens: 700,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: buildConsolidatePrompt(memories, clock, data.timeZone || "UTC") }],
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return { ok: false as const, facts: [] as Array<{ text: string; createdAt?: number }> };
      const body = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      return {
        ok: true as const,
        facts: parseConsolidateResult(body.choices?.[0]?.message?.content ?? ""),
      };
    } catch {
      return { ok: false as const, facts: [] as Array<{ text: string; createdAt?: number }> };
    }
  });

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
