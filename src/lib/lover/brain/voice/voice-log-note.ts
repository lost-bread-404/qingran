import { TALK_FAIL } from "../../talk-fail.ts";
import {
  formatVoiceInputCharsLine,
  stripLabel,
  type VoiceInputChars,
  type VoiceStrip,
} from "./pack-build.ts";
import type { Effort } from "../config.ts";

export type VoiceAttemptNote = {
  strip: VoiceStrip;
  model?: string;
  effort?: Effort;
  status: number | null;
  finishReason: string | null;
  chars: number;
  ms: number;
  ttftMs?: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  otherEvents: string;
  empty: boolean;
  ok: boolean;
  message: string | null;
};

export type VoiceModelFallbackNote = {
  from: string;
  to: string;
  reason: string;
};

function tokenPart(prompt: number | null, completion: number | null): string {
  return `usage prompt_tokens=${prompt ?? "-"} completion_tokens=${completion ?? "-"}`;
}

function tryLine(i: number, a: VoiceAttemptNote): string {
  const tag = a.ok ? "ok" : a.empty ? "empty" : "fail";
  const model = a.model ? `model=${a.model}` : null;
  const effort = a.effort ? `effort=${a.effort}` : null;
  const ttft = a.ttftMs != null ? `ttft_ms=${a.ttftMs}` : null;
  return [
    `try${i + 1}`,
    stripLabel(a.strip),
    tag,
    model,
    effort,
    ttft,
    `status=${a.status ?? "-"}`,
    `finish_reason=${a.finishReason ?? "-"}`,
    `chars=${a.chars}`,
    `ms=${a.ms}`,
    `prompt_tokens=${a.promptTokens ?? "-"}`,
    `completion_tokens=${a.completionTokens ?? "-"}`,
  ]
    .filter(Boolean)
    .join(" ");
}

export function formatVoiceLogNote(opts: {
  attempts: VoiceAttemptNote[];
  usedStrip: VoiceStrip;
  chars: VoiceInputChars;
  failed: boolean;
  failMessage?: string | null;
  modelFallback?: VoiceModelFallbackNote | null;
  injectLine?: string | null;
}): string {
  const used = opts.attempts.at(-1);
  const n = opts.attempts.length;
  const lines: string[] = [];
  if (opts.failed) {
    lines.push(opts.failMessage || TALK_FAIL.empty);
    if (n > 1) lines.push(`第${n}次仍空，${stripLabel(opts.usedStrip)}`);
  } else {
    lines.push(`第${n}次成功，${stripLabel(opts.usedStrip)}`);
  }
  if (opts.modelFallback) {
    lines.push(
      `model_fallback=yes reason=${opts.modelFallback.reason} from=${opts.modelFallback.from} to=${opts.modelFallback.to}`,
    );
  } else {
    lines.push("model_fallback=no");
  }
  if (used) {
    const ttft = used.ttftMs != null ? ` ttft_ms=${used.ttftMs}` : "";
    lines.push(
      `status=${used.status ?? "-"} finish_reason=${used.finishReason ?? "-"}${ttft} ${tokenPart(used.promptTokens, used.completionTokens)}`,
    );
  }
  const events = opts.attempts
    .map((a) => a.otherEvents)
    .filter(Boolean)
    .join("\n")
    .slice(0, 500);
  lines.push(events ? `events=${events}` : "events=(none)");
  lines.push(formatVoiceInputCharsLine(opts.chars));
  if (opts.injectLine) lines.push(opts.injectLine);
  if (n > 1) {
    for (let i = 0; i < n; i++) lines.push(tryLine(i, opts.attempts[i]!));
  }
  return lines.join("\n");
}
