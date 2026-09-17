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
import { codeVersion, HIGH_FREQ_ROUTES, maybeWriteRawLog, xaiStoreEnabled } from "./log-refs.ts";

export { extractJson };

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
  schema?: JsonSchema;
  tools?: ToolDef[];
  previous?: unknown[];
  jobId?: string;
  turnSeq?: number | null;
  refs?: unknown;
  outputRef?: string | null;
  keepOutputText?: boolean;
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

function userPartsOf(input: CallModelInput): string[] {
  if (input.inputParts && input.inputParts.length) return input.inputParts;
  return [input.input];
}

function joinedUser(input: CallModelInput): string {
  return userPartsOf(input).join("\n-----\n");
}

function inputCharsOf(input: CallModelInput): number {
  return input.system.length + userPartsOf(input).reduce((s, p) => s + p.length, 0);
}

export const SPEND_HOLD_ERR = "spend-paused";

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

  const high = HIGH_FREQ_ROUTES.has(route);
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
    inputSystem: high ? null : input.system,
    inputUser: high ? null : joinedUser(input),
  };

  const hold = await checkSpend(route);
  if (!hold.allow) {
    const result = fail(SPEND_HOLD_ERR);
    await appendBrainLog({ ...failLog, ms: result.ms, note: SPEND_HOLD_ERR, error: SPEND_HOLD_ERR });
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
    await appendBrainLog({ ...failLog, ms: result.ms, note: "no-key", error: "no-key" });
    return result;
  }

  const parts = userPartsOf(input);
  const body: Record<string, unknown> = {
    model: resolved.model,
    input: [{ role: "system", content: input.system }, ...parts.map((content) => ({ role: "user", content }))],
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
  if (input.previous?.length) body.input = [...(body.input as unknown[]), ...input.previous];
  if (route === "reflect") body.prompt_cache_key = REFLECT_PROMPT_CACHE_KEY;

  const skipOutput = high && route === "reflect" && !input.keepOutputText;
  const baseLog = {
    jobId: input.jobId,
    route,
    model: resolved.model,
    effort: resolved.effort == null ? null : String(resolved.effort),
    turnSeq: input.turnSeq ?? null,
    codeVersion: codeVersion(),
    refs: input.refs ?? null,
    outputRef: input.outputRef ?? null,
    inputSystem: high ? null : input.system,
    inputUser: high ? null : joinedUser(input),
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
    const logId = await appendBrainLog({
      ...baseLog,
      step: `${route}:${resolved.model}`,
      ok: res.ok,
      ms,
      inputChars: inputCharsOf(input),
      raw: text.slice(0, 4000),
      note: res.ok ? null : `http ${res.status}`,
      outputText: skipOutput ? null : text,
      tokensIn: usage.tokensIn ?? settled.tokensIn ?? null,
      tokensCached: usage.tokensCached,
      tokensOut: usage.tokensOut ?? settled.tokensOut ?? null,
      tokensReasoning: usage.tokensReasoning,
      costUsd: settled.usd,
      costUsdEst: settled.usdEst,
      error: res.ok ? null : `http ${res.status}`,
    });
    await maybeWriteRawLog(logId, { system: input.system, user: userPartsOf(input) });
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
    if (!res.ok) return { ...fail("http"), ms, raw, logId };
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
    const logId = await appendBrainLog({
      ...baseLog,
      step: `${route}:${resolved.model}`,
      ok: false,
      ms,
      inputChars: inputCharsOf(input),
      raw: "",
      note: timedOut ? "timeout" : "error",
      error: timedOut ? "timeout" : "error",
    });
    return { ...fail(timedOut ? "timeout" : "error"), ms, logId };
  }
}
