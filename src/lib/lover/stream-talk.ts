import WebSocket from "ws";
import { applyAvailabilityFallback, checkModelAvailability, resolveRoute, VOICE_IO, type Effort } from "./brain/config";
import { spokenForTts } from "./speech-tags";
import { shouldFlushSpoken, ttsRequestBody, ttsSpeed } from "./tts";
import type { VoiceChatMessage } from "./brain/types";
import {
  TALK_FAIL,
  classifyTalkException,
  describeNonTextTalkEvent,
  isRetryableEmptyTalk,
  logTalkTurn,
  takeTalkDelta,
  talkFailFromResult,
} from "./talk-fail.ts";
import { recordTtsSpend } from "./brain/spend/check";

const MAX_INPUT = 2000;
const PCM_MIME = `audio/pcm;rate=${VOICE_IO.sampleRate}`;

export type TalkStreamEvent =
  | { t: "text"; d: string }
  | { t: "text_end"; speech: string }
  | { t: "audio"; i: number; b: string; m: string; replace?: boolean }
  | { t: "timing"; k: string; ms: number }
  | {
      t: "done";
      speech: string;
      replyId?: string;
      status?: number | null;
      finishReason?: string | null;
      ms?: number;
      chars?: number;
      ttftMs?: number;
    }
  | {
      t: "err";
      m: string;
      code?: string;
      status?: number | null;
      finishReason?: string | null;
      ms?: number;
      chars?: number;
      tts?: boolean;
    };

export type TalkStreamInput = {
  text: string;
  messages: VoiceChatMessage[];
  replyId?: string;
  voiceSpeed?: number;
  failOnEmpty?: boolean;
  model?: string;
  effort?: Effort;
  timeoutMs?: number;
};

type Emit = (event: TalkStreamEvent) => void;

export type TalkStreamResult = {
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    cached_tokens?: number;
  } | null;
  ttftMs: number | null;
  firstAudioMs: number | null;
  model: string;
  effort: Effort;
  ttsChars: number;
  status: number | null;
  finishReason: string | null;
  ms: number;
  chars: number;
  otherEvents: string;
};

function emptyResult(partial: Partial<TalkStreamResult> = {}): TalkStreamResult {
  return {
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
    ...partial,
  };
}

export async function runTalkStream(data: TalkStreamInput, emit: Emit): Promise<TalkStreamResult> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    emit({ t: "err", m: "这会儿连不上。" });
    return emptyResult({ otherEvents: "no XAI_API_KEY" });
  }

  const say = data.text.trim().slice(0, MAX_INPUT);
  if (!say) {
    emit({ t: "err", m: "先说一句。" });
    return emptyResult({ otherEvents: "empty user text" });
  }

  const speed = ttsSpeed(data.voiceSpeed ?? 1);
  void checkModelAvailability(apiKey);
  const base = resolveRoute("voice");
  const route = applyAvailabilityFallback({
    ...base,
    model: data.model || base.model,
    effort: data.effort !== undefined ? data.effort : base.effort,
    timeoutMs: data.timeoutMs || base.timeoutMs,
  });
  let t0 = Date.now();
  let ttftSent = false;
  let firstAudioSent = false;
  let ttftMs: number | null = null;
  let firstAudioMs: number | null = null;
  let usage: TalkStreamResult["usage"] = null;
  let status: number | null = null;
  let finishReason: string | null = null;
  const otherParts: string[] = [];
  let sseBytes = 0;
  let sseChunks = 0;
  const takeOtherEvents = () => {
    const joined = otherParts.join("\n").slice(0, 500);
    if (joined) return joined;
    return `no_nontext_events sse_bytes=${sseBytes} sse_chunks=${sseChunks} finish_reason=${finishReason ?? "-"}`;
  };
  const timedEmit: Emit = (event) => {
    if (event.t === "audio" && !firstAudioSent) {
      firstAudioMs = Date.now() - t0;
      emit({ t: "timing", k: "first_audio_ms", ms: firstAudioMs });
      firstAudioSent = true;
    }
    emit(event);
  };
  const live: { tts: LiveTts | null } = { tts: null };
  const ensureTts = () => {
    live.tts ??= new LiveTts(apiKey, timedEmit, speed);
    return live.tts;
  };

  const fail = (message: string, log: ReturnType<typeof talkFailFromResult>["log"], ttsOnly = false) => {
    logTalkTurn(log);
    if (!ttsOnly) live.tts?.abort();
    emit({
      t: "err",
      m: message,
      status: log.status,
      finishReason: log.finishReason,
      ms: log.ms,
      chars: log.chars,
      tts: ttsOnly || undefined,
    });
  };

  let res: Response;
  try {
    const body: Record<string, unknown> = {
      model: route.model,
      temperature: 0.85,
      max_tokens: route.maxOutput,
      stream: true,
      stream_options: { include_usage: true },
      messages: data.messages,
    };
    if (route.effort) body.reasoning_effort = route.effort;
    t0 = Date.now();
    res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(route.timeoutMs),
    });
  } catch (err) {
    const outcome = talkFailFromResult({ kind: "exception", threw: err, ms: Date.now() - t0 });
    fail(outcome.message ?? TALK_FAIL.network, outcome.log);
    const ex = classifyTalkException(err);
    return emptyResult({
      model: route.model,
      effort: route.effort,
      ms: Date.now() - t0,
      otherEvents: `${ex.name}: ${ex.message}`.slice(0, 500),
    });
  }
  status = res.status;

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const outcome = talkFailFromResult({
      kind: "http",
      status: res.status,
      body,
      ms: Date.now() - t0,
    });
    fail(outcome.message ?? TALK_FAIL.network, outcome.log);
    return emptyResult({
      model: route.model,
      effort: route.effort,
      status,
      ms: Date.now() - t0,
      otherEvents: body.slice(0, 500),
    });
  }
  if (!res.body) {
    const outcome = talkFailFromResult({
      kind: "ok",
      status: res.status,
      finishReason: null,
      speech: "",
      ms: Date.now() - t0,
    });
    if (data.failOnEmpty && isRetryableEmptyTalk({ status: res.status, finishReason: null, speech: "" })) {
      live.tts?.abort();
      logTalkTurn(outcome.log);
      return emptyResult({
        model: route.model,
        effort: route.effort,
        status,
        ms: Date.now() - t0,
        otherEvents: "empty body",
      });
    }
    fail(outcome.message ?? TALK_FAIL.empty, outcome.log);
    return emptyResult({ model: route.model, effort: route.effort, status, ms: Date.now() - t0, otherEvents: "empty body" });
  }

  let full = "";
  let pending = "";
  let firstSpoken = true;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  const ingestToken = (token: string) => {
    if (!token) return;
    if (!ttftSent) {
      ttftMs = Date.now() - t0;
      emit({ t: "timing", k: "ttft_ms", ms: ttftMs });
      ttftSent = true;
    }
    full += token;
    pending += token;
    emit({ t: "text", d: token });
    if (shouldFlushSpoken(pending, firstSpoken)) {
      ensureTts().push(pending);
      pending = "";
      firstSpoken = false;
    }
  };

  const handleJson = (json: unknown) => {
    const obj = json as { usage?: TalkStreamResult["usage"] };
    if (obj.usage) usage = obj.usage;
    const { token, finishReason: nextReason } = takeTalkDelta(json);
    if (nextReason) finishReason = nextReason;
    const described = describeNonTextTalkEvent(json);
    if (described) otherParts.push(described);
    if (token) ingestToken(token);
  };

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith(":")) return;
    sseChunks += 1;
    let payload = trimmed;
    if (trimmed.startsWith("data:")) payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      handleJson(JSON.parse(payload));
    } catch {
      otherParts.push(payload.slice(0, 200));
    }
  };

  const drainBuf = (final: boolean) => {
    const lines = buf.split("\n");
    buf = final ? "" : (lines.pop() ?? "");
    for (const line of lines) handleLine(line);
    if (final && buf.trim()) {
      const leftover = buf.trim();
      buf = "";
      if (leftover.startsWith("{") || leftover.startsWith("[")) {
        try {
          handleJson(JSON.parse(leftover));
          return;
        } catch {
          /* fall through as SSE lines */
        }
      }
      leftover.split("\n").forEach(handleLine);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBytes += value.byteLength;
    buf += decoder.decode(value, { stream: true });
    drainBuf(false);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  buf += decoder.decode();
  drainBuf(true);

  if (pending.trim()) ensureTts().push(pending);
  const speech = full.trim();
  const outcome = talkFailFromResult({
    kind: "ok",
    status: status ?? 200,
    finishReason,
    speech,
    ms: Date.now() - t0,
  });
  const otherEvents = takeOtherEvents();
  if (outcome.message) {
    if (data.failOnEmpty && isRetryableEmptyTalk({ status: status ?? 200, finishReason, speech })) {
      live.tts?.abort();
      logTalkTurn(outcome.log);
      return {
        usage,
        ttftMs,
        firstAudioMs,
        model: route.model,
        effort: route.effort,
        ttsChars: 0,
        status,
        finishReason,
        ms: Date.now() - t0,
        chars: 0,
        otherEvents,
      };
    }
    emit({ t: "text_end", speech });
    fail(outcome.message, outcome.log);
    return {
      usage,
      ttftMs,
      firstAudioMs,
      model: route.model,
      effort: route.effort,
      ttsChars: live.tts?.chars ?? 0,
      status,
      finishReason,
      ms: Date.now() - t0,
      chars: speech.length,
      otherEvents,
    };
  }
  emit({ t: "text_end", speech });
  logTalkTurn(outcome.log);

  if (live.tts) await live.tts.finish();

  let ttsChars = live.tts?.chars ?? 0;
  if (!live.tts?.complete) {
    const clip = await speakRest(apiKey, speech, speed);
    if (clip?.b) {
      timedEmit({ t: "audio", i: 0, b: clip.b, m: clip.m, replace: true });
      ttsChars = spokenForTts(speech).length;
    } else {
      fail(TALK_FAIL.tts, { ...outcome.log, chars: speech.length }, true);
    }
  }

  emit({
    t: "done",
    speech,
    replyId: data.replyId,
    status,
    finishReason,
    ms: Date.now() - t0,
    chars: speech.length,
    ttftMs: ttftMs ?? undefined,
  });
  return {
    usage,
    ttftMs,
    firstAudioMs,
    model: route.model,
    effort: route.effort,
    ttsChars,
    status,
    finishReason,
    ms: Date.now() - t0,
    chars: speech.length,
    otherEvents,
  };
}

class LiveTts {
  gotAudio = false;
  complete = false;
  chars = 0;
  private socket: WebSocket | null = null;
  private opened = false;
  private failed = false;
  private closed = false;
  private seq = 0;
  private queued: string[] = [];
  private waitDone: Promise<void>;
  private resolveDone = () => undefined as void;
  private rejectDone = (_err: Error) => undefined as void;

  private apiKey: string;
  private emit: Emit;
  private speed: number;

  constructor(apiKey: string, emit: Emit, speed = 1) {
    this.apiKey = apiKey;
    this.emit = emit;
    this.speed = speed;
    this.waitDone = new Promise<void>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    }).catch(() => undefined);

    const params = new URLSearchParams({
      language: VOICE_IO.language,
      voice: VOICE_IO.voice,
      codec: VOICE_IO.codec,
      sample_rate: String(VOICE_IO.sampleRate),
      text_normalization: "true",
      optimize_streaming_latency: "1",
      speed: String(this.speed),
    });
    const url = `${VOICE_IO.ttsWsUrl}?${params.toString()}`;
    try {
      const socket = new WebSocket(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      this.socket = socket;
      socket.on("open", () => {
        this.opened = true;
        for (const delta of this.queued) this.send(delta);
        this.queued = [];
      });
      socket.on("message", (raw: WebSocket.RawData) => this.onMessage(raw));
      socket.on("error", () => {
        this.failed = true;
        this.finishSocket();
      });
      socket.on("close", () => {
        this.finishSocket();
      });
      setTimeout(() => {
        if (!this.opened) {
          this.failed = true;
          this.finishSocket();
        }
      }, 8_000);
    } catch {
      this.failed = true;
      this.resolveDone();
    }
  }

  setEmit(emit: Emit) {
    this.emit = emit;
  }

  push(text: string) {
    const spoken = text.replace(/\r/g, "").trim();
    if (!spoken || this.failed || this.closed) return;
    this.chars += spoken.length;
    if (!this.opened) {
      this.queued.push(spoken);
      return;
    }
    this.send(spoken);
  }

  async finish() {
    if (this.closed) return;
    if (this.failed || !this.socket || !this.opened) {
      this.finishSocket();
      return;
    }
    try {
      this.socket.send(JSON.stringify({ type: "text.done" }));
    } catch {
      this.finishSocket();
      return;
    }
    const timeout = new Promise<void>((resolve) => {
      setTimeout(resolve, 45_000);
    });
    await Promise.race([this.waitDone, timeout]);
    this.finishSocket();
  }

  abort() {
    this.failed = true;
    this.finishSocket();
  }

  private send(delta: string) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.queued.push(delta);
      return;
    }
    try {
      this.socket.send(JSON.stringify({ type: "text.delta", delta }));
    } catch {
      this.failed = true;
    }
  }

  private onMessage(raw: WebSocket.RawData) {
    let event: { type?: string; delta?: string; message?: string };
    try {
      event = JSON.parse(String(raw)) as { type?: string; delta?: string; message?: string };
    } catch {
      return;
    }
    if (event.type === "audio.delta" && event.delta) {
      this.gotAudio = true;
      this.emit({ t: "audio", i: this.seq, b: event.delta, m: PCM_MIME });
      this.seq += 1;
      return;
    }
    if (event.type === "audio.done") {
      this.complete = true;
      this.resolveDone();
      return;
    }
    if (event.type === "error") {
      this.failed = true;
      this.finishSocket();
    }
  }

  private finishSocket() {
    if (this.closed) return;
    this.closed = true;
    this.resolveDone();
    if (this.chars) void recordTtsSpend(this.chars);
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
  }
}

async function speakRest(apiKey: string, text: string, speed: number): Promise<{ b: string; m: string } | null> {
  const spoken = spokenForTts(text);
  if (!spoken) return null;
  try {
    const res = await fetch(VOICE_IO.ttsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(ttsRequestBody(spoken, VOICE_IO.language, speed)),
      signal: AbortSignal.timeout(40_000),
    });
    if (!res.ok) return null;
    void recordTtsSpend(spoken.length);
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      b: buf.toString("base64"),
      m: res.headers.get("content-type") || PCM_MIME,
    };
  } catch {
    return null;
  }
}
