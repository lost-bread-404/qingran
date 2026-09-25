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
import { formatVoiceLogNote, type VoiceAttemptNote, type VoiceModelFallbackNote } from "./voice-log-note.ts";
import { sameVoicePick, type VoiceModelPick } from "../config.ts";

export { formatVoiceLogNote };
export type { VoiceAttemptNote, VoiceModelFallbackNote };

export type VoiceFallbackInput = {
  text: string;
  parts: VoicePackParts;
  replyId?: string;
  voiceSpeed?: number;
  primary: VoiceModelPick;
  safety: VoiceModelPick;
  tools?: TalkStreamInput["tools"];
  resolveTool?: (call: { id: string; name: string; arguments: string }) => Promise<string>;
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
  modelFallback: VoiceModelFallbackNote | null;
  toolNote: string | null;
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
    model: result.model,
    effort: result.effort ?? null,
    status: result.status,
    finishReason: result.finishReason,
    chars: trimmed.length,
    ms: result.ms,
    ttftMs: result.ttftMs,
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
  effort: null,
  ttsChars: 0,
  status: null,
  finishReason: null,
  ms: 0,
  chars: 0,
  otherEvents: "",
});

function pickLabel(pick: VoiceModelPick): string {
  return `${pick.model}/${pick.effort ?? "none"}`;
}

function emptyRetryable(result: TalkStreamResult, speech: string): boolean {
  return isRetryableEmptyTalk({
    status: result.status,
    finishReason: result.finishReason,
    speech,
  });
}

export function classifyVoiceModelFallback(opts: {
  status: number | null;
  finishReason: string | null;
  speech: string;
  failMessage: string | null;
  otherEvents?: string;
}): string {
  const speech = opts.speech.trim();
  if (opts.status && opts.status !== 200) {
    const body = (opts.otherEvents ?? "").replace(/\s+/g, " ").slice(0, 200);
    return `http_error ${opts.status} ${body}`.trim();
  }
  if (opts.failMessage === TALK_FAIL.timeout) return "timeout";
  if (opts.failMessage === TALK_FAIL.network) return "http_error network";
  if (!speech) return "empty";
  return (opts.failMessage || "error").slice(0, 200);
}

function streamArgs(
  data: VoiceFallbackInput,
  messages: VoiceChatMessage[],
  pick: VoiceModelPick,
  failOnEmpty: boolean,
  tools?: TalkStreamInput["tools"],
): TalkStreamInput {
  return {
    text: data.text,
    messages,
    replyId: data.replyId,
    voiceSpeed: data.voiceSpeed,
    failOnEmpty,
    model: pick.model,
    effort: pick.effort,
    timeoutMs: pick.timeoutMs,
    tools,
  };
}

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
  let model = data.primary;
  let safetyTried = false;
  let modelFallback: VoiceModelFallbackNote | null = null;

  let toolNote: string | null = null;
  const runOnce = async (
    pick: VoiceModelPick,
    strip: VoiceStrip,
    messages: VoiceChatMessage[],
    lastTry: boolean,
    tools?: TalkStreamInput["tools"],
  ): Promise<{
    result: TalkStreamResult;
    spoken: string;
    failMessage: string | null;
    heldErr: Extract<TalkStreamEvent, { t: "err" }> | null;
  }> => {
    failMessage = null;
    speech = "";
    let heldErr: Extract<TalkStreamEvent, { t: "err" }> | null = null;
    let result: TalkStreamResult;
    try {
      result = await stream(streamArgs(data, messages, pick, !lastTry, tools), (event) => {
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
      });
    } catch (err) {
      const ex = classifyTalkException(err);
      failMessage = talkExceptionHint(ex.kind);
      result = {
        ...emptyStreamResult(),
        model: pick.model,
        effort: pick.effort,
        otherEvents: `${ex.name}: ${ex.message}`.slice(0, 500),
      };
      heldErr = { t: "err", m: failMessage };
    }
    last = result;
    const spoken = speech.trim();
    attempts.push(toAttempt(result, strip, spoken, failMessage));
    return { result, spoken, failMessage, heldErr };
  };

  const ok = (
    out: { result: TalkStreamResult; spoken: string },
    strip: VoiceStrip,
    messages: VoiceChatMessage[],
    note: string | null,
  ): VoiceFallbackResult => ({
    result: out.result,
    attempts,
    usedStrip: strip,
    failed: false,
    speech: out.spoken,
    failMessage: null,
    usage: sumUsage(attempts),
    messages,
    modelFallback,
    toolNote: note,
  });

  const giveUp = (
    out: { result: TalkStreamResult; spoken: string; failMessage: string | null; heldErr: Extract<TalkStreamEvent, { t: "err" }> | null },
    strip: VoiceStrip,
    messages: VoiceChatMessage[],
  ): VoiceFallbackResult => {
    if (out.heldErr) emit(out.heldErr);
    return {
      result: out.result,
      attempts,
      usedStrip: strip,
      failed: true,
      speech: out.spoken,
      failMessage: out.failMessage ?? TALK_FAIL.empty,
      usage: sumUsage(attempts),
      messages,
      modelFallback,
      toolNote: null,
    };
  };

  for (let i = 0; i < VOICE_STRIPS.length; i++) {
    const strip = VOICE_STRIPS[i]!;
    const lastStrip = i === VOICE_STRIPS.length - 1;
    const messages = voiceMessagesForStrip(data.parts, strip);
    lastMessages = messages;
    const safetyAvailable = !safetyTried && !sameVoicePick(data.primary, data.safety);
    const withTools = i === 0 && data.tools?.length ? data.tools : undefined;
    let out = await runOnce(model, strip, messages, lastStrip && !safetyAvailable && !withTools, withTools);
    const call = out.result.toolCalls?.[0];
    if (call && data.resolveTool && !out.spoken) {
      const started = Date.now();
      let toolText = "";
      try {
        toolText = await data.resolveTool(call);
      } catch (err) {
        toolText = err instanceof Error ? err.message : "查不到";
      }
      toolNote = `${call.name} ${call.arguments.slice(0, 180)} ms=${Date.now() - started}`.slice(0, 400);
      const nextMessages: VoiceChatMessage[] = [
        ...messages,
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: call.id || "call", type: "function", function: { name: call.name, arguments: call.arguments } }],
        },
        { role: "tool", content: toolText, tool_call_id: call.id || "call" },
      ];
      out = await runOnce(model, strip, nextMessages, lastStrip && !safetyAvailable);
      lastMessages = nextMessages;
    } else if (withTools && !out.spoken && !out.result.toolCalls?.length && toolsRejected(out.result)) {
      out = await runOnce(model, strip, messages, lastStrip && !safetyAvailable);
    }
    if (out.spoken && !out.failMessage) return ok(out, strip, lastMessages, toolNote);

    const currentEmpty = emptyRetryable(out.result, out.spoken);
    if (safetyAvailable) {
      safetyTried = true;
      modelFallback = {
        from: pickLabel(model),
        to: pickLabel(data.safety),
        reason: classifyVoiceModelFallback({
          status: out.result.status,
          finishReason: out.result.finishReason,
          speech: out.spoken,
          failMessage: out.failMessage,
          otherEvents: out.result.otherEvents,
        }),
      };
      const primaryHardError = Boolean(out.failMessage) && !currentEmpty;
      out = await runOnce(data.safety, strip, messages, lastStrip);
      if (primaryHardError) model = data.safety;
      if (out.spoken && !out.failMessage) return ok(out, strip, messages, toolNote);
    }

    const retry = currentEmpty || emptyRetryable(out.result, out.spoken);
    if (!retry || lastStrip) return giveUp(out, strip, messages);
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
    modelFallback,
    toolNote,
  };
}

function toolsRejected(result: TalkStreamResult): boolean {
  const status = result.status ?? 0;
  if (status === 400 || status === 422) return true;
  return result.otherEvents.toLowerCase().includes("tool");
}
