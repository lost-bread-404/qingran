import type { Profile } from "./types";

export type TalkStreamEvent =
  | { t: "text"; d: string }
  | { t: "text_end"; speech: string }
  | { t: "audio"; i: number; b: string; m: string; replace?: boolean }
  | { t: "timing"; k: string; ms: number }
  | { t: "done"; speech: string; replyId?: string }
  | { t: "err"; m: string };

export type TalkClientInput = {
  text: string;
  userMsgId: string;
  userCreatedAt: number;
  profile: Profile;
  nowMs?: number;
  timeZone?: string;
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
    onEvent({ t: "err", m: "这会儿连不上。" });
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
        void reader.read().then(async function drain(next): Promise<void> {
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
        return;
      }
    }
    if (audioTimer) window.clearTimeout(audioTimer);
    flushAudio();
  };

  await consume();
}
