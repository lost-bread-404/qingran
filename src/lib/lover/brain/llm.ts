import {
  applyAvailabilityFallback,
  checkModelAvailability,
  resolveRoute,
  type Effort,
  type Route,
} from "./config.ts";
import { appendBrainLog } from "./store.ts";
import { extractJson } from "./text.ts";

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
  schema?: JsonSchema;
  tools?: ToolDef[];
  previous?: unknown[];
  jobId?: string;
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

  if (!apiKey) {
    const result = fail("no-key");
    await appendBrainLog({
      jobId: input.jobId,
      step: `${route}:${resolved.model}`,
      ok: false,
      ms: result.ms,
      inputChars: input.system.length + input.input.length,
      raw: "",
      note: "no-key",
    });
    return result;
  }

  const body: Record<string, unknown> = {
    model: resolved.model,
    input: [
      { role: "system", content: input.system },
      { role: "user", content: input.input },
    ],
    max_output_tokens: resolved.maxOutput,
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
    const usage = (raw && typeof raw === "object" ? (raw as { usage?: Record<string, unknown> }).usage : null) ?? {};
    const detailsIn = (usage.input_tokens_details as Record<string, unknown> | undefined) ?? {};
    const detailsOut = (usage.output_tokens_details as Record<string, unknown> | undefined) ?? {};
    const note = `model=${resolved.model} effort=${String(resolved.effort)} in=${usage.input_tokens ?? "?"} cached=${detailsIn.cached_tokens ?? usage.cached_tokens ?? "?"} out=${usage.output_tokens ?? "?"} reason=${detailsOut.reasoning_tokens ?? usage.reasoning_tokens ?? "?"}`;
    await appendBrainLog({
      jobId: input.jobId,
      step: `${route}:${resolved.model}`,
      ok: res.ok,
      ms,
      inputChars: input.system.length + input.input.length,
      raw: text.slice(0, 4000),
      note,
    });
    if (!res.ok) return { ...fail("http"), ms, raw };
    return {
      ok: true,
      text,
      json,
      toolCalls,
      raw,
      model: resolved.model,
      effort: resolved.effort,
      ms,
    };
  } catch (err) {
    const ms = Date.now() - started;
    const timedOut = err instanceof Error && /timeout|aborted/i.test(err.message);
    await appendBrainLog({
      jobId: input.jobId,
      step: `${route}:${resolved.model}`,
      ok: false,
      ms,
      inputChars: input.system.length + input.input.length,
      raw: "",
      note: timedOut ? "timeout" : "error",
    });
    return { ...fail(timedOut ? "timeout" : "error"), ms };
  }
}
