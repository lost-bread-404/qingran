import { TALK_FAIL } from "../../talk-fail.ts";
import {
  formatVoiceInputCharsLine,
  stripLabel,
  type VoiceInputChars,
  type VoiceStrip,
} from "./pack-build.ts";

export type VoiceAttemptNote = {
  strip: VoiceStrip;
  status: number | null;
  finishReason: string | null;
  chars: number;
  ms: number;
  promptTokens: number | null;
  completionTokens: number | null;
  otherEvents: string;
  empty: boolean;
  ok: boolean;
  message: string | null;
};

function tokenPart(prompt: number | null, completion: number | null): string {
  return `usage prompt_tokens=${prompt ?? "-"} completion_tokens=${completion ?? "-"}`;
}

function tryLine(i: number, a: VoiceAttemptNote): string {
  const tag = a.ok ? "ok" : a.empty ? "empty" : "fail";
  return [
    `try${i + 1}`,
    stripLabel(a.strip),
    tag,
    `status=${a.status ?? "-"}`,
    `finish_reason=${a.finishReason ?? "-"}`,
    `chars=${a.chars}`,
    `ms=${a.ms}`,
    `prompt_tokens=${a.promptTokens ?? "-"}`,
    `completion_tokens=${a.completionTokens ?? "-"}`,
  ].join(" ");
}

export function formatVoiceLogNote(opts: {
  attempts: VoiceAttemptNote[];
  usedStrip: VoiceStrip;
  chars: VoiceInputChars;
  failed: boolean;
  failMessage?: string | null;
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
  if (used) {
    lines.push(
      `status=${used.status ?? "-"} finish_reason=${used.finishReason ?? "-"} ${tokenPart(used.promptTokens, used.completionTokens)}`,
    );
  }
  const events = opts.attempts
    .map((a) => a.otherEvents)
    .filter(Boolean)
    .join("\n")
    .slice(0, 500);
  lines.push(events ? `events=${events}` : "events=(none)");
  lines.push(formatVoiceInputCharsLine(opts.chars));
  if (n > 1) {
    for (let i = 0; i < n; i++) lines.push(tryLine(i, opts.attempts[i]!));
  }
  return lines.join("\n");
}
