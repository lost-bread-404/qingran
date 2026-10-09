import {
  applyAvailabilityFallback,
  checkModelAvailability,
  resolveRoute,
  type Effort,
  type Route,
} from "./config.ts";
import { appendBrainLog } from "./store.ts";
import { extractJson } from "./text.ts";
import { parseUsage, settleLlmCost } from "./usage.ts";
import { recordLlmSpend } from "./spend/check.ts";
import { xaiCreds, xaiFetch } from "../xai-auth.ts";
import { jobRateHit, SPEND_RATE_ERR } from "./spend/rate.ts";
import { codeVersion, maybeWriteRawLog, xaiStoreEnabled } from "./log-refs.ts";
import { applyPromptModel } from "./prompts/models.ts";
import { storedPromptModel } from "./prompts/model-store.ts";
import { claudeBody, claudeFetch, claudeFinish, claudeText, claudeUsage, CLAUDE_TIMEOUT_MS, isClaudeModel } from "../claude.ts";
import type { XaiMessage } from "../photos.ts";

export function finishReasonFromApi(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const choice = Array.isArray(o.choices) ? (o.choices[0] as Record<string, unknown> | undefined) : undefined;
  if (typeof choice?.finish_reason === "string" && choice.finish_reason) return choice.finish_reason;
  if (typeof o.finish_reason === "string" && o.finish_reason) return o.finish_reason;
  const inc =
    o.incomplete_details && typeof o.incomplete_details === "object"
      ? (o.incomplete_details as { reason?: unknown }).reason
      : undefined;
  if (typeof inc === "string" && inc) return inc;
  if (typeof o.status === "string" && o.status) return o.status;
  return null;
}

export type JsonSchema = {
  name: string;
  schema: Record<string, unknown>;
};

export type CallModelInput = {
  system: string;
  input: string;
  inputParts?: string[];
  messages?: Array<{ role: string; content: string }>;
  schema?: JsonSchema;
  jobId?: string;
  turnSeq?: number | null;
  refs?: unknown;
  outputRef?: string | null;
  keepOutputText?: boolean;
  promptKey?: string | null;
  promptHash?: string | null;
  /** Replay comparison. When set, this model is used instead of the route default. */
  model?: string | null;
  effort?: Effort;
  /** With `model`: how long that model may take (replay gives it what the live reply would). */
  timeoutMs?: number;
  /** Sampling temperature; unset keeps the model default. */
  temperature?: number;
};

export type CallModelResult = {
  ok: boolean;
  text: string;
  json: unknown;
  raw: unknown;
  model: string;
  effort: Effort;
  ms: number;
  logId?: number | null;
  failKind?: "timeout" | "parse_error" | "http_error" | "error";
  httpStatus?: number | null;
  responseSnippet?: string | null;
  usage?: {
    tokensIn: number | null;
    tokensCached: number | null;
    tokensOut: number | null;
    tokensReasoning: number | null;
    costUsd: number | null;
  };
};

function outputText(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const body = raw as {
    output_text?: string;
    output?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string }>;
      arguments?: string;
      name?: string;
    }>;
    choices?: Array<{ message?: { content?: string } }>;
  };
  if (typeof body.output_text === "string" && body.output_text.trim()) return body.output_text;
  if (Array.isArray(body.output)) {
    const chunks: string[] = [];
    for (const item of body.output) {
      if (item?.type === "message" && Array.isArray(item.content)) {
        for (const c of item.content) {
          if ((c.type === "output_text" || c.type === "text") && c.text) chunks.push(c.text);
        }
      }
    }
    if (chunks.length) return chunks.join("");
  }
  const chat = body.choices?.[0]?.message?.content;
  return typeof chat === "string" ? chat : "";
}

function parseJsonLoose(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(extractJson(text));
  } catch {
    return null;
  }
}

function apiMessagesOf(input: CallModelInput): Array<{ role: string; content: string }> {
  if (input.messages?.length) return input.messages.map((message) => ({ role: message.role, content: message.content }));
  return [{ role: "system", content: input.system }, ...userPartsOf(input).map((content) => ({ role: "user", content }))];
}

function userPartsOf(input: CallModelInput): string[] {
  if (input.inputParts && input.inputParts.length) return input.inputParts;
  return [input.input];
}

function joinedUser(input: CallModelInput): string {
  const messages = apiMessagesOf(input);
  let skippedSystem = false;
  const parts: string[] = [];
  for (const message of messages) {
    if (!skippedSystem && message.role === "system") {
      skippedSystem = true;
      continue;
    }
    parts.push(message.content);
  }
  return parts.join("\n-----\n");
}

function inputCharsOf(input: CallModelInput): number {
  return apiMessagesOf(input).reduce((sum, message) => sum + message.content.length, 0);
}

function responseSnippet(raw: unknown, err?: unknown): string {
  const text =
    typeof raw === "string"
      ? raw
      : raw != null
        ? JSON.stringify(raw)
        : err instanceof Error
          ? err.message
          : String(err ?? "");
  return text.replace(/\s+/g, " ").slice(0, 200);
}

function logMessagesOf(input: CallModelInput): Array<{ role: string; content: string }> {
  const messages = [...apiMessagesOf(input)];
  return messages;
}

export function asModelInput(
  messages: Array<{ role: string; content: string }>,
): Pick<CallModelInput, "system" | "input" | "inputParts" | "messages"> {
  const index = messages.findIndex((message) => message.role === "system");
  const system = index >= 0 ? messages[index]!.content : "";
  const rest = messages.filter((_, i) => i !== index);
  return {
    system,
    input: rest.map((message) => message.content).join("\n-----\n"),
    inputParts: rest.map((message) => message.content),
    messages,
  };
}

export async function callModel(route: Route, input: CallModelInput): Promise<CallModelResult> {
  const started = Date.now();
  const apiKey = process.env.XAI_API_KEY;
  await checkModelAvailability(apiKey);
  const creds = await xaiCreds();
  const overrideKey = (input.promptKey && input.promptKey.trim()) || route;
  const override = input.model ? null : await storedPromptModel(overrideKey);
  let resolved = applyAvailabilityFallback(applyPromptModel(resolveRoute(route), override));
  if (input.model) {
    resolved = {
      ...resolved,
      model: input.model,
      effort: input.effort === undefined ? resolved.effort : input.effort,
      timeoutMs: input.timeoutMs ?? resolved.timeoutMs,
    };
  }
  const fail = (note: string): CallModelResult => ({
    ok: false,
    text: "",
    json: null,
    raw: null,
    model: resolved.model,
    effort: resolved.effort,
    ms: Date.now() - started,
  });

  const failLog = {
    jobId: input.jobId,
    step: `${route}:${resolved.model}`,
    ok: false,
    ms: 0,
    inputChars: inputCharsOf(input),
    raw: "",
    route,
    model: resolved.model,
    effort: resolved.effort == null ? null : String(resolved.effort),
    turnSeq: input.turnSeq ?? null,
    codeVersion: codeVersion(),
    refs: input.refs ?? null,
    outputRef: input.outputRef ?? null,
    promptKey: input.promptKey ?? null,
    promptHash: input.promptHash ?? null,
    inputSystem: input.system,
    inputUser: joinedUser(input),
  };

  if (input.jobId) {
    const rate = await jobRateHit();
    if (rate.limited) {
      throw Object.assign(new Error(SPEND_RATE_ERR), { code: SPEND_RATE_ERR });
    }
  }

  const isClaude = isClaudeModel(resolved.model);
  if (!creds.length && !isClaude) {
    const result = fail("no-key");
    const logId = await appendBrainLog({ ...failLog, ms: result.ms, note: "no-key", error: "no-key" });
    await maybeWriteRawLog(logId, { messages: logMessagesOf(input) });
    return result;
  }

  const apiMessages = apiMessagesOf(input);
  const body: Record<string, unknown> = {
    model: resolved.model,
    input: apiMessages,
    max_output_tokens: resolved.maxOutput,
    store: xaiStoreEnabled(),
  };
  if (resolved.effort) body.reasoning = { effort: resolved.effort };
  if (input.schema) {
    body.text = {
      format: {
        type: "json_schema",
        name: input.schema.name,
        schema: input.schema.schema,
        strict: true,
      },
    };
  }
  if (input.temperature != null) body.temperature = input.temperature;

  const baseLog = {
    jobId: input.jobId,
    route,
    model: resolved.model,
    effort: resolved.effort == null ? null : String(resolved.effort),
    turnSeq: input.turnSeq ?? null,
    codeVersion: codeVersion(),
    refs: input.refs ?? null,
    outputRef: input.outputRef ?? null,
    promptKey: input.promptKey ?? null,
    promptHash: input.promptHash ?? null,
    inputSystem: input.system,
    inputUser: joinedUser(input),
  };

  try {
    const sent = isClaude
      ? {
          res: await claudeFetch(
            claudeBody(apiMessages as XaiMessage[], resolved.model, { stream: false, effort: resolved.effort, maxTokens: resolved.maxOutput }),
            Math.max(resolved.timeoutMs, CLAUDE_TIMEOUT_MS),
          ),
          cred: { kind: "api" as const },
        }
      : await xaiFetch("https://api.x.ai/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(resolved.timeoutMs),
        });
    if (!sent) throw new Error("no-key");
    const { res, cred } = sent;
    const raw = await res.json().catch(() => null);
    const text = isClaude ? claudeText(raw) : outputText(raw);
    const json = parseJsonLoose(text);
    const ms = Date.now() - started;
    const usageRawApi = (raw && typeof raw === "object" ? (raw as { usage?: unknown }).usage : null) ?? null;
    const usageRaw = isClaude ? claudeUsage(usageRawApi) : usageRawApi;
    const usage = parseUsage(usageRaw);
    const settled = settleLlmCost(resolved.model, usage, input.system + joinedUser(input), text);
    const finish = isClaude ? claudeFinish((raw as { stop_reason?: unknown } | null)?.stop_reason) : finishReasonFromApi(raw);
    const failNote = res.ok ? null : `http_error ${res.status} ${responseSnippet(raw)}`;
    const logId = await appendBrainLog({
      ...baseLog,
      step: `${route}:${resolved.model}`,
      ok: res.ok,
      ms,
      inputChars: inputCharsOf(input),
      raw: text.slice(0, 4000),
      note: [failNote ?? (finish ? `finish_reason=${finish}` : null), cred.kind === "sub" ? "SuperGrok" : null].filter(Boolean).join(" · ") || null,
      outputText: text,
      tokensIn: usage.tokensIn ?? settled.tokensIn ?? null,
      tokensCached: usage.tokensCached,
      tokensOut: usage.tokensOut ?? settled.tokensOut ?? null,
      tokensReasoning: usage.tokensReasoning,
      costUsd: settled.usd,
      costUsdEst: settled.usdEst,
      error: failNote,
    });
    await maybeWriteRawLog(logId, { messages: logMessagesOf(input) });
    await recordLlmSpend({
      paidBy: cred.kind,
      route,
      model: resolved.model,
      usage,
      inputText: input.system + joinedUser(input),
      outputText: text,
      jobId: input.jobId,
      logId,
      turnSeq: input.turnSeq,
    });
    if (!res.ok) {
      const snippet = responseSnippet(raw);
      return {
        ...fail("http"),
        ms,
        raw,
        logId,
        failKind: "http_error",
        httpStatus: res.status,
        responseSnippet: snippet,
      };
    }
    return {
      ok: true,
      text,
      json,
      raw,
      model: resolved.model,
      effort: resolved.effort,
      ms,
      logId,
      usage: { ...usage, costUsd: settled.usd },
    };
  } catch (err) {
    if (err instanceof Error && (err.message === SPEND_RATE_ERR || (err as { code?: string }).code === SPEND_RATE_ERR)) {
      throw err;
    }
    const ms = Date.now() - started;
    const timedOut = err instanceof Error && /timeout|aborted/i.test(err.message);
    const snippet = responseSnippet(null, err);
    const failKind = timedOut ? "timeout" : "http_error";
    const logId = await appendBrainLog({
      ...baseLog,
      step: `${route}:${resolved.model}`,
      ok: false,
      ms,
      inputChars: inputCharsOf(input),
      raw: "",
      note: failKind,
      error: timedOut ? "timeout" : `http_error 0 ${snippet}`,
    });
    await maybeWriteRawLog(logId, { messages: logMessagesOf(input) });
    return {
      ...fail(timedOut ? "timeout" : "error"),
      ms,
      logId,
      failKind,
      httpStatus: timedOut ? null : 0,
      responseSnippet: snippet,
    };
  }
}
