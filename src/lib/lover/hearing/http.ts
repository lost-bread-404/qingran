import {
  estimateCostUsd,
  HEARING,
  hearingTimeoutMs,
  selfhostApiKey,
  selfhostBaseUrl,
  selfhostModel,
  type HearingProviderId,
} from "./config.ts";
import { HEARING_INSTRUCTION } from "./instruction.ts";
import { NBEST_INSTRUCTION } from "./nbest.ts";
import { looksLikeRefusal, parseHearingJson, type HearingResult } from "./schema.ts";
import type { HearingAdapterOutcome, HearingFailReason } from "./select.ts";

export type AdapterFail = Extract<HearingAdapterOutcome, { ok: false }>;
export type AdapterOk = Extract<HearingAdapterOutcome, { ok: true }>;
export type AdapterOutcome = HearingAdapterOutcome;

export type HearingCallOpts = {
  context?: string;
  nbest?: boolean;
};

const USER_PROMPT = "转写这段中文口语。按系统说明输出严格 JSON。";

export function hearingSystemPrompt(opts?: HearingCallOpts): string {
  const parts = [HEARING_INSTRUCTION];
  if (opts?.nbest) parts.push(NBEST_INSTRUCTION);
  if (opts?.context?.trim()) parts.push(opts.context.trim());
  return parts.join("\n\n");
}

const MODERATION_RE =
  /data_inspection_failed|datainspectionfailed|ip_infringement_suspect|ipinfringementsuspect|custom_role_blocked|customroleblocked|internalerror\.algo\.datainspection/i;

const GEMINI_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
] as const;

export function isModerationHttpError(status: number, raw: string): boolean {
  if (status !== 400 && status !== 403) return false;
  return MODERATION_RE.test(raw);
}

export function classifyGeminiResponse(body: {
  promptFeedback?: { blockReason?: string };
  candidates?: { finishReason?: string }[];
}): "refusal" | "schema" | "ok" {
  const block = (body.promptFeedback?.blockReason ?? "").toUpperCase();
  if (block && block !== "BLOCK_REASON_UNSPECIFIED") return "refusal";
  const finish = (body.candidates?.[0]?.finishReason ?? "").toUpperCase();
  if (finish === "SAFETY" || finish === "PROHIBITED_CONTENT" || finish === "BLOCKLIST" || finish === "SPII") {
    return "refusal";
  }
  if (finish === "MAX_TOKENS") return "schema";
  return "ok";
}

export function clipFallbackRaw(raw?: string | null): string | null {
  if (!raw) return null;
  return raw.slice(0, 2000);
}

export async function hearWithQwen(audioBase64: string, opts?: HearingCallOpts): Promise<AdapterOutcome> {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  const model = HEARING.qwen.model;
  if (!apiKey) return missing("qwen", model);
  return openaiAudioChat({
    provider: "qwen",
    model,
    url: `${HEARING.qwen.baseUrl}/chat/completions`,
    apiKey,
    audioBase64,
    audioStyle: "input_audio",
    extra: { modalities: ["text"] },
    preferStream: true,
    opts,
  });
}

export async function hearWithGemini(audioBase64: string, opts?: HearingCallOpts): Promise<AdapterOutcome> {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = HEARING.gemini.model;
  if (!apiKey) return missing("gemini", model);
  const started = Date.now();
  const timeout = hearingTimeoutMs();
  try {
    const res = await fetch(`${HEARING.gemini.generateUrl}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: hearingSystemPrompt(opts) }] },
        contents: [
          {
            role: "user",
            parts: [
              { inline_data: { mime_type: "audio/wav", data: audioBase64 } },
              { text: USER_PROMPT },
            ],
          },
        ],
        safetySettings: GEMINI_SAFETY_SETTINGS,
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: 800,
          thinkingConfig: { thinkingLevel: "low" },
        },
      }),
      signal: AbortSignal.timeout(timeout),
    });
    const latency_ms = Date.now() - started;
    const rawText = await res.text().catch(() => "");
    const body = parseJsonBody(rawText) as {
      error?: { message?: string };
      promptFeedback?: { blockReason?: string };
      candidates?: { finishReason?: string; content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const rawBody = (rawText || JSON.stringify(body)).slice(0, 2000);
    if (!res.ok) {
      const msg = body.error?.message || rawBody || `gemini ${res.status}`;
      return {
        ok: false,
        reason: res.status === 408 ? "timeout" : isModerationHttpError(res.status, msg) ? "refusal" : "http",
        raw: rawBody || msg,
        status: res.status,
        latency_ms,
        provider: "gemini",
        model,
      };
    }
    const verdict = classifyGeminiResponse(body);
    if (verdict === "refusal") {
      return {
        ok: false,
        reason: "refusal",
        raw: rawBody,
        latency_ms,
        provider: "gemini",
        model,
      };
    }
    const raw = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const parsed = finishParse("gemini", model, raw, latency_ms, {
      in: body.usageMetadata?.promptTokenCount,
      out: body.usageMetadata?.candidatesTokenCount,
    });
    if (verdict === "schema" && !parsed.ok) {
      return { ok: false, reason: "schema", raw, latency_ms, provider: "gemini", model };
    }
    return parsed;
  } catch (err) {
    return failFromError("gemini", model, started, err);
  }
}

export async function hearWithSelfhost(audioBase64: string, opts?: HearingCallOpts): Promise<AdapterOutcome> {
  const base = selfhostBaseUrl();
  const model = selfhostModel();
  if (!base) return missing("selfhost", model);
  const first = await openaiAudioChat({
    provider: "selfhost",
    model,
    url: `${base}/chat/completions`,
    apiKey: selfhostApiKey(),
    audioBase64,
    audioStyle: "audio_url",
    extra: { response_format: { type: "json_object" } },
    preferStream: false,
    opts,
  });
  if (first.ok || first.reason === "timeout" || first.reason === "refusal") return first;
  return openaiAudioChat({
    provider: "selfhost",
    model,
    url: `${base}/chat/completions`,
    apiKey: selfhostApiKey(),
    audioBase64,
    audioStyle: "input_audio",
    extra: { response_format: { type: "json_object" } },
    preferStream: false,
    opts,
  });
}

export async function warmupSelfhost(): Promise<{
  ok: boolean;
  latency_ms: number;
  cold: boolean;
  error?: string;
}> {
  const base = selfhostBaseUrl();
  const model = selfhostModel();
  if (!base) return { ok: false, latency_ms: 0, cold: false, error: "missing_url" };
  const started = Date.now();
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${selfhostApiKey()}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 8,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const latency_ms = Date.now() - started;
    if (!res.ok) {
      return { ok: false, latency_ms, cold: latency_ms > 8_000, error: `http ${res.status}` };
    }
    return { ok: true, latency_ms, cold: latency_ms > 8_000 };
  } catch (err) {
    const latency_ms = Date.now() - started;
    return {
      ok: false,
      latency_ms,
      cold: latency_ms > 8_000,
      error: err instanceof Error ? err.message : "warmup_failed",
    };
  }
}

async function openaiAudioChat(input: {
  provider: HearingProviderId;
  model: string;
  url: string;
  apiKey: string;
  audioBase64: string;
  extra?: Record<string, unknown>;
  preferStream: boolean;
  audioStyle: "input_audio" | "audio_url";
  opts?: HearingCallOpts;
}): Promise<AdapterOutcome> {
  const started = Date.now();
  const timeout = hearingTimeoutMs();
  const payload = {
    model: input.model,
    temperature: 0,
    max_tokens: 800,
    messages: [
      { role: "system", content: hearingSystemPrompt(input.opts) },
      {
        role: "user",
        content: [
          { type: "text", text: USER_PROMPT },
          audioPart(input.audioBase64, input.audioStyle),
        ],
      },
    ],
    ...input.extra,
  };

  const tryOnce = async (stream: boolean) => {
    const res = await fetch(input.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({ ...payload, stream }),
      signal: AbortSignal.timeout(timeout),
    });
    return res;
  };

  try {
    let res = await tryOnce(input.preferStream);
    if (!res.ok && input.preferStream && (res.status === 400 || res.status === 422)) {
      const peek = await res.clone().text().catch(() => "");
      if (!isModerationHttpError(res.status, peek)) {
        res = await tryOnce(false);
      }
    } else if (!res.ok && !input.preferStream && (res.status === 400 || res.status === 422)) {
      const peek = await res.clone().text().catch(() => "");
      if (!isModerationHttpError(res.status, peek)) {
        res = await tryOnce(true);
      }
    }
    const latency_ms = Date.now() - started;
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return {
        ok: false,
        reason: res.status === 408 ? "timeout" : isModerationHttpError(res.status, errText) ? "refusal" : "http",
        raw: errText.slice(0, 2000),
        status: res.status,
        latency_ms,
        provider: input.provider,
        model: input.model,
      };
    }
    if (res.headers.get("content-type")?.includes("text/event-stream") || input.preferStream) {
      const streamed = await readOpenAiStream(res);
      return finishParse(input.provider, input.model, streamed.text, latency_ms, streamed.usage);
    }
    const body = (await res.json()) as {
      choices?: { message?: { content?: string | { text?: string }[] } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const raw = messageContent(body.choices?.[0]?.message?.content);
    return finishParse(input.provider, input.model, raw, latency_ms, {
      in: body.usage?.prompt_tokens,
      out: body.usage?.completion_tokens,
    });
  } catch (err) {
    return failFromError(input.provider, input.model, started, err);
  }
}

function audioPart(audioBase64: string, style: "input_audio" | "audio_url") {
  if (style === "audio_url") {
    return {
      type: "audio_url",
      audio_url: { url: `data:audio/wav;base64,${audioBase64}` },
    };
  }
  return {
    type: "input_audio",
    input_audio: { data: audioBase64, format: "wav" },
  };
}

async function readOpenAiStream(res: Response): Promise<{
  text: string;
  usage?: { in?: number; out?: number };
}> {
  if (!res.body) return { text: "" };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let usage: { in?: number; out?: number } | undefined;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload) as {
          choices?: { delta?: { content?: string }; message?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        text += json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.message?.content ?? "";
        if (json.usage) {
          usage = { in: json.usage.prompt_tokens, out: json.usage.completion_tokens };
        }
      } catch {
        continue;
      }
    }
  }
  return { text, usage };
}

function messageContent(content: string | { text?: string }[] | undefined): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => p.text ?? "").join("");
  return "";
}

function finishParse(
  provider: HearingProviderId,
  model: string,
  raw: string,
  latency_ms: number,
  tokens?: { in?: number; out?: number },
): AdapterOutcome {
  if (looksLikeRefusal(raw)) {
    return { ok: false, reason: "refusal", raw, latency_ms, provider, model };
  }
  try {
    const parsed = parseHearingJson(raw);
    const tokens_in = tokens?.in;
    const tokens_out = tokens?.out;
    return {
      ok: true,
      result: {
        ...parsed,
        raw,
        latency_ms,
        provider,
        model,
        refusal: false,
        tokens_in,
        tokens_out,
        cost_usd:
          tokens_in != null && tokens_out != null
            ? estimateCostUsd(provider, tokens_in, tokens_out)
            : undefined,
      },
    };
  } catch {
    return { ok: false, reason: "schema", raw, latency_ms, provider, model };
  }
}

function missing(provider: HearingProviderId, model: string): AdapterFail {
  return { ok: false, reason: "missing_key", latency_ms: 0, provider, model };
}

function parseJsonBody(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function failFromError(
  provider: HearingProviderId,
  model: string,
  started: number,
  err: unknown,
): AdapterFail {
  const latency_ms = Date.now() - started;
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : "";
  const timeout = name === "TimeoutError" || name === "AbortError" || /timeout|aborted/i.test(message);
  const reason: HearingFailReason = timeout ? "timeout" : "http";
  return {
    ok: false,
    reason,
    raw: message.slice(0, 2000),
    latency_ms,
    provider,
    model,
  };
}
