import WebSocket from "ws";
import { applyAvailabilityFallback, checkModelAvailability, resolveRoute, VOICE_IO, type Effort } from "./brain/config";
import { shouldFlushSpoken, ttsSpeed } from "./tts";
import { SpeakerCut, type Cast } from "./cast";
import { PCM_MIME, speakWhole } from "./speak";
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
import { xaiCreds, xaiFetch, type XaiCred } from "./xai-auth";
import { BraceCut } from "./brain/voice/brace-cut";
import { VoiceLeveler } from "./voice-level";
import { withPhotos } from "./photos";
import { claudeBody, claudeFetch, claudeFinish, claudeUsage, isClaudeModel, CLAUDE_TIMEOUT_MS } from "./claude";

const MAX_INPUT = 2000;

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
  /** Her setting (profile.voiceTemperature). Missing → 1.0. */
  temperature?: number;
  /** Who reads which block: castOf(profile) (人设 page). */
  cast?: Cast;
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
  /** What he wrote inside ｛｝: kept to himself, never shown or spoken. */
  innerNotes?: string;
  /** Who paid: her SuperGrok subscription or the API key. */
  paidBy?: "sub" | "api";
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
  const creds = await xaiCreds();
  if (!creds.length) {
    emit({ t: "err", m: "这会儿连不上。" });
    return emptyResult({ otherEvents: "no xAI credential" });
  }
  // Claude or Grok writes the words, by the model she picked (设置 → 回复); xAI speaks them either way.
  const claude = isClaudeModel(data.model);
  // Whoever paid for the words also speaks them (SuperGrok first, the API key after it). Claude's words: the key.
  let cred: XaiCred = apiKey ? { kind: "api", token: apiKey } : creds[0]!;

  const say = data.text.trim().slice(0, MAX_INPUT);
  const herLine = [...data.messages].reverse().find((m) => m.role === "user");
  if (!say && !herLine?.images?.length) {
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
    timeoutMs: claude ? Math.max(CLAUDE_TIMEOUT_MS, data.timeoutMs ?? 0) : data.timeoutMs || base.timeoutMs,
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
  const live: { tts: VoiceChain | null } = { tts: null };
  const ensureTts = () => {
    live.tts ??= new VoiceChain(cred, timedEmit, speed);
    return live.tts;
  };
  const cast = data.cast ?? {};

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
    if (claude) {
      t0 = Date.now();
      res = await claudeFetch(claudeBody(await withPhotos(data.messages), route.model, { stream: true, effort: route.effort }), route.timeoutMs);
    } else {
    const body: Record<string, unknown> = {
      model: route.model,
      temperature: typeof data.temperature === "number" ? data.temperature : 1.0,
      max_tokens: route.maxOutput,
      stream: true,
      stream_options: { include_usage: true },
      messages: await withPhotos(data.messages),
    };
    if (route.effort) body.reasoning_effort = route.effort;
    t0 = Date.now();
    const sent = await xaiFetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(route.timeoutMs),
    });
    if (!sent) throw new Error("no xAI credential");
    res = sent.res;
    cred = sent.cred;
    }
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

  const speakers = new SpeakerCut(cast);
  /** Everything shown and spoken (his ｛｝ notes are taken out by `braces`). */
  let spoken = "";
  const braces = new BraceCut();
  /**
   * Claude's words come in bursts with pauses between them; streamed as they came, his voice ran dry between bursts
   * and the words jumped (10/4: 「一卡一卡的」). Its reply is short and quick to finish once it starts, so it goes out
   * whole: shown at once and read in one go.
   */
  let held = "";
  /** Claude's usage comes in two parts (prompt at the start, output at the end). */
  let claudeStart: Record<string, unknown> = {};
  let claudeOut = 0;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  const emitVisible = (token: string) => {
    if (!token) return;
    spoken += token;
    if (!ttftSent) {
      ttftMs = Date.now() - t0;
      emit({ t: "timing", k: "ttft_ms", ms: ttftMs });
      ttftSent = true;
    }
    emit({ t: "text", d: token });
    for (const part of speakers.push(token)) ensureTts().say(part.voice, part.text);
  };

  const ingestToken = (token: string) => {
    if (!token) return;
    const out = braces.push(token);
    if (claude) held += out;
    else emitVisible(out);
  };

  const handleClaude = (json: unknown) => {
    const o = (json && typeof json === "object" ? json : {}) as Record<string, any>;
    if (o.type === "message_start") claudeStart = (o.message?.usage as Record<string, unknown>) ?? {};
    else if (o.type === "content_block_delta" && o.delta?.type === "text_delta") ingestToken(String(o.delta.text ?? ""));
    else if (o.type === "message_delta") {
      if (typeof o.usage?.output_tokens === "number") claudeOut = o.usage.output_tokens;
      if (o.delta?.stop_reason) finishReason = claudeFinish(o.delta.stop_reason);
    } else if (o.type === "error") {
      finishReason = "error";
      otherParts.push(JSON.stringify(o.error ?? o).slice(0, 300));
    }
    usage = claudeUsage({ ...claudeStart, output_tokens: claudeOut });
  };

  const handleJson = (json: unknown) => {
    if (claude) {
      handleClaude(json);
      return;
    }
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
    if (trimmed.startsWith(":") || trimmed.startsWith("event:")) return;
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
  braces.finish();
  if (claude) emitVisible(held);
  const speech = spoken.trim();
  const innerNotes = braces.text();

  for (const part of speakers.finish()) ensureTts().say(part.voice, part.text);
  live.tts?.flush();
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
        innerNotes,
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
      paidBy: cred.kind,
      status,
      finishReason,
      ms: Date.now() - t0,
      chars: speech.length,
      otherEvents,
      innerNotes,
    };
  }
  emit({ t: "text_end", speech });
  logTalkTurn(outcome.log);

  if (live.tts) await live.tts.finish();

  let ttsChars = live.tts?.chars ?? 0;
  if (!live.tts?.complete) {
    const clip = await speakWhole(speech, cast, speed);
    if (clip.ok) {
      timedEmit({ t: "audio", i: 0, b: clip.audio.toString("base64"), m: clip.mime, replace: true });
      ttsChars = clip.chars;
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
    paidBy: cred.kind,
    status,
    finishReason,
    ms: Date.now() - t0,
    chars: speech.length,
    otherEvents,
    innerNotes,
  };
}

/**
 * The live voice of one reply. Each stretch by one person is his own xAI stream in his voice (the voice is fixed
 * when the stream opens); all of them are read at once, and their audio goes out in the order they were written.
 */
class VoiceChain {
  private segments: Array<{ voice: string; tts: LiveTts; pending: string; first: boolean; held: Array<{ b: string; m: string }>; ended: boolean }> = [];
  private head = 0;
  private seq = 0;
  private finishing: Promise<void>[] = [];
  private aborted = false;

  constructor(
    private cred: XaiCred,
    private emit: Emit,
    private speed: number,
  ) {}

  /** Text for this voice; a new voice closes the stretch before it. */
  say(voice: string, text: string) {
    let seg = this.segments[this.segments.length - 1];
    if (!seg || seg.voice !== voice) {
      // Nothing to read yet (blank lines, bold marks, a lone quote): no stream of its own until there is.
      if (this.aborted || !/[\p{L}\p{N}[<]/u.test(text)) return;
      if (seg) this.close(seg);
      const index = this.segments.length;
      seg = { voice, tts: null as unknown as LiveTts, pending: "", first: index === 0, held: [], ended: false };
      this.segments.push(seg);
      seg.tts = new LiveTts(this.cred, voice, this.speed, {
        audio: (b, m) => this.audio(index, b, m),
        end: () => this.ended(index),
      });
    }
    seg.pending += text;
    if (shouldFlushSpoken(seg.pending, seg.first)) {
      seg.tts.push(seg.pending);
      seg.pending = "";
      seg.first = false;
    }
  }

  /** What is still waiting in the last stretch. */
  flush() {
    const seg = this.segments[this.segments.length - 1];
    if (seg?.pending.trim()) seg.tts.push(seg.pending);
    if (seg) seg.pending = "";
  }

  private close(seg: (typeof this.segments)[number]) {
    if (seg.pending.trim()) seg.tts.push(seg.pending);
    seg.pending = "";
    this.finishing.push(seg.tts.finish());
  }

  private audio(index: number, b: string, m: string) {
    if (this.aborted) return;
    if (index === this.head) this.emit({ t: "audio", i: this.seq++, b, m });
    else this.segments[index]?.held.push({ b, m });
  }

  private ended(index: number) {
    if (this.aborted) return;
    const seg = this.segments[index];
    if (seg) seg.ended = true;
    while (this.segments[this.head]?.ended) {
      this.head += 1;
      const next = this.segments[this.head];
      if (!next) break;
      for (const clip of next.held) this.emit({ t: "audio", i: this.seq++, b: clip.b, m: clip.m });
      next.held = [];
    }
  }

  async finish() {
    const last = this.segments[this.segments.length - 1];
    if (last) this.close(last);
    await Promise.all(this.finishing);
  }

  abort() {
    // Nothing held for later stretches goes out after this.
    this.aborted = true;
    for (const seg of this.segments) seg.tts.abort();
  }

  get chars() {
    return this.segments.reduce((n, seg) => n + seg.tts.chars, 0);
  }

  /** Every stretch was read to the end. */
  get complete() {
    return this.segments.length > 0 && this.segments.every((seg) => seg.tts.complete);
  }
}

type TtsSink = { audio: (b: string, m: string) => void; end: () => void };

class LiveTts {
  gotAudio = false;
  private level = new VoiceLeveler();
  complete = false;
  chars = 0;
  private socket: WebSocket | null = null;
  private opened = false;
  private failed = false;
  private closed = false;
  private queued: string[] = [];
  private waitDone: Promise<void>;
  /** Settles when the socket opens or is given up. */
  private opening: Promise<void>;
  private resolveOpening = () => undefined as void;
  private resolveDone = () => undefined as void;
  private rejectDone = (_err: Error) => undefined as void;

  private cred: XaiCred;
  private sink: TtsSink;
  private speed: number;

  constructor(cred: XaiCred, voice: string, speed: number, sink: TtsSink) {
    this.cred = cred;
    this.sink = sink;
    this.speed = speed;
    this.opening = new Promise<void>((resolve) => {
      this.resolveOpening = resolve;
    });
    this.waitDone = new Promise<void>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    }).catch(() => undefined);

    const params = new URLSearchParams({
      language: VOICE_IO.language,
      voice,
      codec: VOICE_IO.codec,
      sample_rate: String(VOICE_IO.sampleRate),
      text_normalization: "true",
      optimize_streaming_latency: "1",
      speed: String(this.speed),
    });
    const url = `${VOICE_IO.ttsWsUrl}?${params.toString()}`;
    try {
      const socket = new WebSocket(url, {
        headers: { Authorization: `Bearer ${this.cred.token}` },
      });
      this.socket = socket;
      socket.on("open", () => {
        this.opened = true;
        const queued = this.queued;
        this.queued = [];
        for (const delta of queued) this.send(delta);
        this.resolveOpening();
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
      this.finishSocket();
    }
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
    // A short stretch can be done before its socket is open (another person's stream opens mid-reply): wait for it.
    if (!this.opened && !this.failed && this.socket) await this.opening;
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
      this.sink.audio(this.level.base64(event.delta), PCM_MIME);
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
    this.resolveOpening();
    this.sink.end();
    if (this.chars) void recordTtsSpend(this.chars, null, this.cred.kind);
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
  }
}
