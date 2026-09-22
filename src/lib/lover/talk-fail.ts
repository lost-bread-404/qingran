import { xaiFailHint } from "./xai-error.ts";

export const TALK_FAIL = {
  timeout: "她想太久了，超时了",
  network: "线路有点不稳",
  empty: "她没说出话（空回复）",
  tts: "声音出不来",
} as const;

export type TalkExceptionKind = "timeout" | "network" | "other";

export type TalkTurnLog = {
  status: number | null;
  finishReason: string | null;
  chars: number;
  ms: number;
  exceptionKind?: TalkExceptionKind;
  errorName?: string;
  errorMessage?: string;
};

export type TalkChatResult =
  | { kind: "exception"; threw: unknown; ms: number }
  | { kind: "http"; status: number; body: string; ms: number }
  | { kind: "ok"; status: number; finishReason: string | null; speech: string; ms: number };

export type TalkFailOutcome = {
  message: string | null;
  log: TalkTurnLog;
};

export function classifyTalkException(err: unknown): {
  kind: TalkExceptionKind;
  name: string;
  message: string;
} {
  const name = err instanceof Error ? err.name : typeof err === "object" && err && "name" in err
    ? String((err as { name: unknown }).name)
    : "Error";
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : String(err ?? "");
  if (
    name === "TimeoutError" ||
    (name === "AbortError" && /timeout/i.test(message)) ||
    /aborted due to timeout|operation timed out/i.test(message)
  ) {
    return { kind: "timeout", name, message };
  }
  if (
    name === "TypeError" ||
    /network|fetch|ECONN|ENOTFOUND|EAI_AGAIN|Failed to fetch|socket/i.test(message)
  ) {
    return { kind: "network", name, message };
  }
  return { kind: "other", name, message };
}

export function talkExceptionHint(kind: TalkExceptionKind): string {
  return kind === "timeout" ? TALK_FAIL.timeout : TALK_FAIL.network;
}

export function talkBlockedHint(finishReason: string): string {
  return `这一轮被 xAI 拦下了（finish_reason=${finishReason}）`;
}

export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
      return "";
    })
    .join("");
}

export function takeTalkDelta(json: unknown): { token: string; finishReason: string | null } {
  if (!json || typeof json !== "object") return { token: "", finishReason: null };
  const choice = (json as {
    choices?: {
      delta?: { content?: unknown; text?: unknown };
      message?: { content?: unknown };
      text?: unknown;
      finish_reason?: string | null;
    }[];
  }).choices?.[0];
  const token =
    contentToText(choice?.delta?.content) ||
    contentToText(choice?.delta?.text) ||
    contentToText(choice?.message?.content) ||
    contentToText(choice?.text);
  const finish = choice?.finish_reason;
  return {
    token,
    finishReason: typeof finish === "string" && finish ? finish : null,
  };
}

const USAGE_ONLY_KEYS = new Set(["usage", "id", "object", "created", "model", "system_fingerprint"]);

export function describeNonTextTalkEvent(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const { token } = takeTalkDelta(json);
  if (token) return null;
  const obj = json as Record<string, unknown>;
  const hasChoices = Array.isArray(obj.choices) && obj.choices.length > 0;
  if (!hasChoices) {
    const keys = Object.keys(obj);
    if (obj.usage != null && keys.every((k) => USAGE_ONLY_KEYS.has(k))) return null;
    const copy = { ...obj };
    delete copy.usage;
    const s = JSON.stringify(copy);
    return s && s !== "{}" ? s : null;
  }
  const copy = { ...obj };
  delete copy.usage;
  return JSON.stringify(copy);
}

export function isRetryableEmptyTalk(opts: {
  status: number | null;
  finishReason: string | null;
  speech: string;
}): boolean {
  if (opts.status !== 200) return false;
  if (opts.speech.trim()) return false;
  const reason = opts.finishReason;
  if (reason && reason !== "stop" && reason !== "length") return false;
  return true;
}

export function talkFailFromResult(result: TalkChatResult): TalkFailOutcome {
  if (result.kind === "exception") {
    const ex = classifyTalkException(result.threw);
    return {
      message: talkExceptionHint(ex.kind),
      log: {
        status: null,
        finishReason: null,
        chars: 0,
        ms: result.ms,
        exceptionKind: ex.kind,
        errorName: ex.name,
        errorMessage: ex.message,
      },
    };
  }
  if (result.kind === "http") {
    return {
      message: xaiFailHint(result.status, result.body),
      log: { status: result.status, finishReason: null, chars: 0, ms: result.ms },
    };
  }
  const speech = result.speech.trim();
  const log: TalkTurnLog = {
    status: result.status,
    finishReason: result.finishReason,
    chars: speech.length,
    ms: result.ms,
  };
  const reason = result.finishReason;
  if (reason && reason !== "stop" && reason !== "length") {
    return { message: talkBlockedHint(reason), log };
  }
  if (!speech) return { message: TALK_FAIL.empty, log };
  return { message: null, log };
}

export function formatTalkTurnLog(log: TalkTurnLog): string {
  const parts = [
    "[qingran-talk]",
    `status=${log.status ?? "-"}`,
    `finish_reason=${log.finishReason ?? "-"}`,
    `chars=${log.chars}`,
    `ms=${log.ms}`,
  ];
  if (log.exceptionKind) {
    parts.push(`ex=${log.exceptionKind}`, `${log.errorName}: ${log.errorMessage}`);
  }
  return parts.join(" ");
}

export function logTalkTurn(log: TalkTurnLog) {
  console.error(formatTalkTurnLog(log));
}

export function formatTalkTrace(trace: {
  status?: number | null;
  finishReason?: string | null;
  ms?: number;
}): string {
  return [
    trace.status != null ? `status ${trace.status}` : null,
    trace.finishReason ? `finish_reason=${trace.finishReason}` : null,
    trace.ms != null ? `${trace.ms}ms` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function firstLine(text: string | null | undefined): string {
  return (text ?? "").trim().split(/\r?\n/, 1)[0] ?? "";
}
