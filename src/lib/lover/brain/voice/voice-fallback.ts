import { parseUsage, type TokenUsage } from "../usage.ts";
import { runTalkStream, type TalkStreamEvent, type TalkStreamInput, type TalkStreamResult } from "../../stream-talk.ts";
import { classifyTalkException, isRetryableEmptyTalk, TALK_FAIL, talkExceptionHint } from "../../talk-fail.ts";
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

export type VoiceStreamFn = (
  data: TalkStreamInput,
  emit: (event: TalkStreamEvent) => void,
) => Promise<TalkStreamResult>;

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

const emptyStreamResult = (): TalkStreamResult => ({
  usage: null,
  ttftMs: null,
  firstAudioMs: null,
  model: "",
  ttsChars: 0,
  status: null,
  finishReason: null,
  ms: 0,
  chars: 0,
  otherEvents: "",
});

export async function runVoiceWithFallback(
  data: VoiceFallbackInput,
  emit: (event: TalkStreamEvent) => void,
  stream: VoiceStreamFn = runTalkStream,
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
    let heldErr: Extract<TalkStreamEvent, { t: "err" }> | null = null;
    let result: TalkStreamResult;
    try {
      result = await stream(
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
          if (event.t === "err") {
            if (event.tts) {
              emit(event);
              return;
            }
            failMessage = event.m;
            heldErr = event;
            return;
          }
          emit(event);
        },
      );
    } catch (err) {
      const ex = classifyTalkException(err);
      failMessage = talkExceptionHint(ex.kind);
      result = {
        ...emptyStreamResult(),
        otherEvents: `${ex.name}: ${ex.message}`.slice(0, 500),
      };
      heldErr = { t: "err", m: failMessage };
    }
    last = result;
    const spoken = speech.trim();
    attempts.push(toAttempt(result, strip, spoken, failMessage));
    if (spoken && !failMessage) {
      return {
        result,
        attempts,
        usedStrip: strip,
        failed: false,
        speech: spoken,
        failMessage: null,
        usage: sumUsage(attempts),
        messages,
      };
    }
    const retry = isRetryableEmptyTalk({
      status: result.status,
      finishReason: result.finishReason,
      speech: spoken,
    });
    if (!retry || lastTry) {
      if (heldErr) emit(heldErr);
      return {
        result,
        attempts,
        usedStrip: strip,
        failed: true,
        speech: spoken,
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
