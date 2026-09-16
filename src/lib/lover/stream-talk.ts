import WebSocket from "ws";
import { buildSystemPrompt, formatClock } from "./prompt";
import { spokenForTts } from "./speech-tags";
import { shouldFlushSpoken, ttsRequestBody, ttsSpeed } from "./tts";
import type { ChatMessage, Memory, Profile } from "./types";

const FAST_MODEL = "grok-4.20-0309-non-reasoning";
const MAX_HISTORY = 60;
const MAX_INPUT = 2000;
const PCM_MIME = "audio/pcm;rate=24000";

export type TalkStreamEvent =
  | { t: "text"; d: string }
  | { t: "text_end"; speech: string }
  | { t: "audio"; i: number; b: string; m: string; replace?: boolean }
  | { t: "done"; speech: string }
  | { t: "err"; m: string };

export type TalkStreamInput = {
  text: string;
  profile: Profile;
  history: ChatMessage[];
  memories: Memory[];
  nowMs?: number;
  timeZone?: string;
};

type Emit = (event: TalkStreamEvent) => void;

export async function runTalkStream(data: TalkStreamInput, emit: Emit): Promise<void> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    emit({ t: "err", m: "这会儿连不上。" });
    return;
  }

  const say = data.text.trim().slice(0, MAX_INPUT);
  if (!say) {
    emit({ t: "err", m: "先说一句。" });
    return;
  }

  const timeZone = data.timeZone || "UTC";
  const clock = formatClock(data.nowMs || Date.now(), timeZone);
  const system = buildSystemPrompt(data.profile, data.memories, clock, timeZone);
  const history = data.history.slice(-MAX_HISTORY).map((m) => ({
    role: m.role,
    content: m.text,
  }));
  const tts = new LiveTts(apiKey, emit, ttsSpeed(Boolean(data.profile.softVoice)));

  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: FAST_MODEL,
      temperature: 0.85,
      max_tokens: 550,
      stream: true,
      messages: [
        { role: "system", content: system },
        ...history,
        { role: "user", content: say },
      ],
    }),
    signal: AbortSignal.timeout(28_000),
  });

  if (!res.ok || !res.body) {
    tts.abort();
    emit({ t: "err", m: `想你的时候卡住了（${res.status}）。` });
    return;
  }

  let full = "";
  let pending = "";
  let firstSpoken = true;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let token = "";
      try {
        const json = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
        };
        token = json.choices?.[0]?.delta?.content ?? "";
      } catch {
        continue;
      }
      if (!token) continue;
      full += token;
      pending += token;
      emit({ t: "text", d: token });
      if (shouldFlushSpoken(pending, firstSpoken)) {
        tts.push(pending);
        pending = "";
        firstSpoken = false;
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  if (pending.trim()) tts.push(pending);
  const speech = full.trim();
  emit({ t: "text_end", speech });
  if (!speech) {
    tts.abort();
    emit({ t: "err", m: "她好像走神了，再说一次。" });
    return;
  }

  await tts.finish();

  if (!tts.complete) {
    const clip = await speakRest(apiKey, speech, ttsSpeed(Boolean(data.profile.softVoice)));
    if (clip?.b) emit({ t: "audio", i: 0, b: clip.b, m: clip.m, replace: true });
  }

  emit({ t: "done", speech });
}

class LiveTts {
  gotAudio = false;
  complete = false;
  private socket: WebSocket | null = null;
  private opened = false;
  private failed = false;
  private closed = false;
  private seq = 0;
  private queued: string[] = [];
  private waitDone: Promise<void>;
  private resolveDone = () => undefined as void;
  private rejectDone = (_err: Error) => undefined as void;

  constructor(
    private apiKey: string,
    private emit: Emit,
    private speed = 1,
  ) {
    this.waitDone = new Promise<void>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    }).catch(() => undefined);

    const params = new URLSearchParams({
      language: "zh",
      voice: "eve",
      codec: "pcm",
      sample_rate: "24000",
      text_normalization: "true",
      optimize_streaming_latency: "1",
      speed: String(this.speed),
    });
    const url = `wss://api.x.ai/v1/tts?${params.toString()}`;
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

  push(text: string) {
    const spoken = text.replace(/\r/g, "").trim();
    if (!spoken || this.failed || this.closed) return;
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
    const res = await fetch("https://api.x.ai/v1/tts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(ttsRequestBody(spoken, "zh", speed)),
      signal: AbortSignal.timeout(40_000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      b: buf.toString("base64"),
      m: res.headers.get("content-type") || PCM_MIME,
    };
  } catch {
    return null;
  }
}
