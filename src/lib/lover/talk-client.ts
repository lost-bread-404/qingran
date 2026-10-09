import type { VoiceNote } from "./native-shell";
import type { Profile } from "./types";
import { xaiFailHint } from "./xai-error";
import { onUnauthorized } from "@/lib/auth-lite/on-unauthorized";

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

export type TalkClientInput = {
  text: string;
  userMsgId: string;
  userCreatedAt: number;
  replyId: string;
  replyCreatedAt?: number;
  profile: Profile;
  nowMs?: number;
  timeZone?: string;
  /** Photos sent with this line (qr_photos ids). */
  images?: string[];
  /**
   * A spoken turn is a round (see /api/talk): her earlier lines not yet answered aloud, kept as their own messages
   * before this one. Its answer is not kept if the page drops it before she hears it.
   */
  earlier?: Array<{ id: string; text: string; at: number }>;
  /** Held or in a call, and what xAI heard for it (its cost is entered by the server). */
  voice?: VoiceNote;
};

export async function streamTalk(
  input: TalkClientInput,
  onEvent: (event: TalkStreamEvent) => void,
  signal?: AbortSignal,
) {
  const res = await fetch("/api/talk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  if (!res.ok || !res.body) {
    if (onUnauthorized(res)) return;
    if (res.status === 429) {
      onEvent({ t: "err", m: "请求太频繁了，稍等一下。", code: "rate" });
      return;
    }
    const body = await res.text().catch(() => "");
    onEvent({ t: "err", m: xaiFailHint(res.status, body) });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const audioWait: TalkStreamEvent[] = [];
  let audioTimer = 0;
  let finished = false;

  const flushAudio = () => {
    audioTimer = 0;
    const batch = audioWait.splice(0);
    for (const event of batch) onEvent(event);
  };

  const consume = async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const chunks = buf.split("\n\n");
      buf = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const line = chunk.split("\n").find((item) => item.startsWith("data:"));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let event: TalkStreamEvent;
        try {
          event = JSON.parse(payload) as TalkStreamEvent;
        } catch {
          continue;
        }
        if (finished && event.t !== "audio") continue;
        if (event.t === "audio") {
          if (finished) {
            onEvent(event);
            continue;
          }
          audioWait.push(event);
          if (!audioTimer) audioTimer = window.setTimeout(flushAudio, 0);
          continue;
        }
        if (event.t === "done" || event.t === "err") {
          if (audioTimer) window.clearTimeout(audioTimer);
          flushAudio();
          onEvent(event);
          finished = true;
          continue;
        }
        onEvent(event);
      }
      if (finished) {
        // His voice can still be coming after his words are done: the call resolves once all of it is in (so the
        // caller knows when he has finished speaking), or after a while if the server never closes the stream.
        const drained = reader.read().then(async function drain(next): Promise<void> {
          if (next.done) return;
          buf += decoder.decode(next.value, { stream: true });
          const chunks = buf.split("\n\n");
          buf = chunks.pop() ?? "";
          for (const chunk of chunks) {
            const line = chunk.split("\n").find((item) => item.startsWith("data:"));
            if (!line) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              const event = JSON.parse(payload) as TalkStreamEvent;
              if (event.t === "audio") onEvent(event);
            } catch {
              /* ignore */
            }
          }
          return reader.read().then(drain);
        });
        await Promise.race([drained.catch(() => undefined), new Promise((resolve) => window.setTimeout(resolve, 15_000))]);
        return;
      }
    }
    if (audioTimer) window.clearTimeout(audioTimer);
    flushAudio();
  };

  await consume();
}
