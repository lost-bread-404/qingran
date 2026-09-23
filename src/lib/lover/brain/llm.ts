import {
  applyAvailabilityFallback,
  checkModelAvailability,
  REFLECT_PROMPT_CACHE_KEY,
  resolveRoute,
  type Effort,
  type Route,
} from "./config.ts";
import { appendBrainLog } from "./store.ts";
import { extractJson } from "./text.ts";
import { parseUsage, settleLlmCost } from "./usage.ts";
import { checkSpend, recordLlmSpend } from "./spend/check.ts";
import { jobRateHit, SPEND_RATE_ERR } from "./spend/rate.ts";
import { codeVersion, maybeWriteRawLog, xaiStoreEnabled } from "./log-refs.ts";

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

export type ToolDef = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ToolCall = {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type CallModelInput = {
  system: string;
  input: string;
  inputParts?: string[];
  messages?: Array<{ role: string; content: string }>;
  schema?: JsonSchema;
  tools?: ToolDef[];
  previous?: unknown[];
  jobId?: string;
  turnSeq?: number | null;
  refs?: unknown;
  outputRef?: string | null;
  keepOutputText?: boolean;
  promptKey?: string | null;
  promptHash?: string | null;
};

export type CallModelResult = {
  ok: boolean;
  text: string;
  json: unknown;
  toolCalls: ToolCall[];
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

function outputToolCalls(raw: unknown): ToolCall[] {
  if (!raw || typeof raw !== "object") return [];
  const body = raw as {
    output?: Array<{
      type?: string;
      call_id?: string;
      id?: string;
      name?: string;
      arguments?: string | Record<string, unknown>;
    }>;
  };
  const calls: ToolCall[] = [];
  for (const item of body.output ?? []) {
    if (item?.type !== "function_call" && item?.type !== "tool_call") continue;
    let args: Record<string, unknown> = {};
    if (typeof item.arguments === "string") {
      try {
        args = JSON.parse(item.arguments) as Record<string, unknown>;
      } catch {
        args = {};
      }
    } else if (item.arguments && typeof item.arguments === "object") {
      args = item.arguments;
    }
    calls.push({
      callId: String(item.call_id || item.id || ""),
      name: String(item.name || ""),
      arguments: args,
    });
  }
  return calls;
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
  if (input.previous?.length) {
    for (const part of input.previous) {
      if (!part || typeof part !== "object") continue;
      const row = part as { role?: unknown; content?: unknown };
      if (row.content == null) continue;
      messages.push({ role: String(row.role || "user"), content: String(row.content) });
    }
  }
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

export const SPEND_HOLD_ERR = "spend-paused";

export function classifyReflectFailure(result: CallModelResult): string {
  if (result.failKind === "timeout") return "timeout";
  if (result.failKind === "http_error") {
    const status = result.httpStatus ?? "";
    const body = (result.responseSnippet ?? "").slice(0, 200);
    return `http_error ${status} ${body}`.trim();
  }
  if (!result.json) return "parse_error";
  return result.failKind === "error" ? "error" : "parse_error";
}

export async function callModel(route: Route, input: CallModelInput): Promise<CallModelResult> {
  const started = Date.now();
  const apiKey = process.env.XAI_API_KEY;
  await checkModelAvailability(apiKey);
  const resolved = applyAvailabilityFallback(resolveRoute(route));
  const fail = (note: string): CallModelResult => ({
    ok: false,
    text: "",
    json: null,
    toolCalls: [],
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

  const hold = await checkSpend(route);
  if (!hold.allow) {
    const result = fail(SPEND_HOLD_ERR);
    const logId = await appendBrainLog({ ...failLog, ms: result.ms, note: SPEND_HOLD_ERR, error: SPEND_HOLD_ERR });
    await maybeWriteRawLog(logId, { messages: logMessagesOf(input) });
    return result;
  }

  if (input.jobId) {
    const rate = await jobRateHit();
    if (rate.limited) {
      throw Object.assign(new Error(SPEND_RATE_ERR), { code: SPEND_RATE_ERR });
    }
  }

  if (!apiKey) {
    const result = fail("no-key");
    const logId = await appendBrainLog({ ...failLog, ms: result.ms, note: "no-key", error: "no-key" });
    await maybeWriteRawLog(logId, { messages: logMessagesOf(input) });
    return result;
  }

  const apiMessages = apiMessagesOf(input);
  const body: Record<string, unknown> = {
    model: resolved.model,
    input: input.previous?.length ? [...apiMessages, ...input.previous] : apiMessages,
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
  if (input.tools?.length) body.tools = input.tools;
  if (route === "reflect") body.prompt_cache_key = REFLECT_PROMPT_CACHE_KEY;

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
    const res = await fetch("https://api.x.ai/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(resolved.timeoutMs),
    });
    const raw = await res.json().catch(() => null);
    const text = outputText(raw);
    const toolCalls = outputToolCalls(raw);
    const json = parseJsonLoose(text);
    const ms = Date.now() - started;
    const usageRaw = (raw && typeof raw === "object" ? (raw as { usage?: unknown }).usage : null) ?? null;
    const usage = parseUsage(usageRaw);
    const settled = settleLlmCost(resolved.model, usage, input.system + joinedUser(input), text);
    const finish = finishReasonFromApi(raw);
    const failNote = res.ok ? null : `http_error ${res.status} ${responseSnippet(raw)}`;
    const logId = await appendBrainLog({
      ...baseLog,
      step: `${route}:${resolved.model}`,
      ok: res.ok,
      ms,
      inputChars: inputCharsOf(input),
      raw: text.slice(0, 4000),
      note: failNote ?? (finish ? `finish_reason=${finish}` : null),
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
      toolCalls,
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
