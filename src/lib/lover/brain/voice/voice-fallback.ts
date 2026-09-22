import { parseUsage, type TokenUsage } from "../usage.ts";
import { runTalkStream, type TalkStreamEvent, type TalkStreamResult } from "../../stream-talk.ts";
import { isRetryableEmptyTalk, TALK_FAIL } from "../../talk-fail.ts";
import {
  VOICE_STRIPS,
  voiceMessagesForStrip,
  type VoicePackParts,
  type VoiceStrip,
} from "./pack-build.ts";
import type { VoiceChatMessage } from "../types.ts";
import { formatVoiceLogNote, type VoiceAttemptNote } from "./voice-log-note.ts";

export { formatVoiceLogNote };
export type { VoiceAttemptNote };

export type VoiceFallbackInput = {
  text: string;
  parts: VoicePackParts;
  replyId?: string;
  voiceSpeed?: number;
};

export type VoiceFallbackResult = {
  result: TalkStreamResult;
  attempts: VoiceAttemptNote[];
  usedStrip: VoiceStrip;
  failed: boolean;
  speech: string;
  failMessage: string | null;
  usage: TokenUsage;
  messages: VoiceChatMessage[];
};

function usageTokens(usage: TalkStreamResult["usage"]): { prompt: number | null; completion: number | null } {
  const u = parseUsage(usage);
  return { prompt: u.tokensIn, completion: u.tokensOut };
}

function sumUsage(attempts: VoiceAttemptNote[]): TokenUsage {
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  for (const a of attempts) {
    if (a.promptTokens != null) tokensIn = (tokensIn ?? 0) + a.promptTokens;
    if (a.completionTokens != null) tokensOut = (tokensOut ?? 0) + a.completionTokens;
  }
  return { tokensIn, tokensCached: null, tokensOut, tokensReasoning: null, costTicks: null };
}

function toAttempt(
  result: TalkStreamResult,
  strip: VoiceStrip,
  speech: string,
  failMessage: string | null,
): VoiceAttemptNote {
  const tokens = usageTokens(result.usage);
  const trimmed = speech.trim();
  return {
    strip,
    status: result.status,
    finishReason: result.finishReason,
    chars: trimmed.length,
    ms: result.ms,
    promptTokens: tokens.prompt,
    completionTokens: tokens.completion,
    otherEvents: result.otherEvents,
    empty: !trimmed,
    ok: Boolean(trimmed) && !failMessage,
    message: failMessage,
  };
}

export async function runVoiceWithFallback(
  data: VoiceFallbackInput,
  emit: (event: TalkStreamEvent) => void,
): Promise<VoiceFallbackResult> {
  const attempts: VoiceAttemptNote[] = [];
  let last: TalkStreamResult | null = null;
  let lastMessages = voiceMessagesForStrip(data.parts, "none");
  let speech = "";
  let failMessage: string | null = null;

  for (let i = 0; i < VOICE_STRIPS.length; i++) {
    const strip = VOICE_STRIPS[i]!;
    const lastTry = i === VOICE_STRIPS.length - 1;
    const messages = voiceMessagesForStrip(data.parts, strip);
    lastMessages = messages;
    failMessage = null;
    speech = "";
    const result = await runTalkStream(
      {
        text: data.text,
        messages,
        replyId: data.replyId,
        voiceSpeed: data.voiceSpeed,
        failOnEmpty: !lastTry,
      },
      (event) => {
        if (event.t === "text_end") speech = event.speech || speech;
        if (event.t === "done") speech = event.speech || speech;
        if (event.t === "err") failMessage = event.m;
        emit(event);
      },
    );
    last = result;
    const trimmed = speech.trim();
    attempts.push(toAttempt(result, strip, trimmed, failMessage));
    if (trimmed && !failMessage) {
      return {
        result,
        attempts,
        usedStrip: strip,
        failed: false,
        speech: trimmed,
        failMessage: null,
        usage: sumUsage(attempts),
        messages,
      };
    }
    const retry = isRetryableEmptyTalk({
      status: result.status,
      finishReason: result.finishReason,
      speech: trimmed,
    });
    if (!retry || lastTry) {
      return {
        result,
        attempts,
        usedStrip: strip,
        failed: true,
        speech: trimmed,
        failMessage: failMessage ?? TALK_FAIL.empty,
        usage: sumUsage(attempts),
        messages,
      };
    }
  }

  return {
    result: last!,
    attempts,
    usedStrip: "thin",
    failed: true,
    speech: "",
    failMessage: failMessage ?? TALK_FAIL.empty,
    usage: sumUsage(attempts),
    messages: lastMessages,
  };
}
