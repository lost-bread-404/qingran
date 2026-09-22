import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EMPTY_MIND } from "../types.ts";
import { runVoiceWithFallback, type VoiceStreamFn } from "./voice-fallback.ts";
import type { VoicePackParts } from "./pack-build.ts";
import type { TalkStreamEvent, TalkStreamResult } from "../../stream-talk.ts";
import { TALK_FAIL } from "../../talk-fail.ts";

function parts(): VoicePackParts {
  return {
    charter: "你就是清然。",
    longterm: "【我自己】医学生",
    history: [],
    userText: "在吗",
    mind: {
      ...EMPTY_MIND,
      turn_seq: 1,
      rosie_now: "累",
      undercurrent: "怕",
      my_feel: "心疼",
      my_view: "先睡",
      my_logic: "停",
      lead_plan: ["躺"],
      intent: "揽过来",
    },
    notes: [],
    clockText: "星期二 21:00",
    timeZone: "UTC",
    careHint: false,
    nowMs: 1,
    mindStale: false,
    jump: false,
  };
}

function result(partial: Partial<TalkStreamResult> = {}): TalkStreamResult {
  return {
    usage: { prompt_tokens: 80, completion_tokens: 0 },
    ttftMs: null,
    firstAudioMs: null,
    model: "voice-test",
    ttsChars: 0,
    status: 200,
    finishReason: "stop",
    ms: 500,
    chars: 0,
    otherEvents: '{"choices":[{"delta":{"role":"assistant"}}]}',
    ...partial,
  };
}

test("empty then text retries without forwarding intermediate err", async () => {
  const bodies: string[] = [];
  const forwarded: TalkStreamEvent[] = [];
  const stream: VoiceStreamFn = async (data, emit) => {
    bodies.push(data.messages.map((m) => m.content).join("\n"));
    if (bodies.length === 1) return result();
    emit({ t: "text", d: "在" });
    emit({ t: "text_end", speech: "在" });
    emit({ t: "done", speech: "在", status: 200, finishReason: "stop", ms: 800, chars: 1 });
    return result({
      usage: { prompt_tokens: 40, completion_tokens: 2 },
      chars: 1,
      ms: 800,
      otherEvents: "",
    });
  };
  const out = await runVoiceWithFallback({ text: "在吗", parts: parts() }, (e) => forwarded.push(e), stream);
  assert.equal(out.failed, false);
  assert.equal(out.speech, "在");
  assert.equal(out.usedStrip, "mind");
  assert.equal(out.attempts.length, 2);
  assert.equal(forwarded.some((e) => e.t === "err"), false);
  assert.match(bodies[0]!, /你此刻的内心|她现在/);
  assert.doesNotMatch(bodies[1]!, /你此刻的内心|她现在：/);
});

test("tts err after speech is not treated as empty", async () => {
  const forwarded: TalkStreamEvent[] = [];
  const stream: VoiceStreamFn = async (_data, emit) => {
    emit({ t: "text", d: "嗯" });
    emit({ t: "text_end", speech: "嗯" });
    emit({ t: "err", m: TALK_FAIL.tts, tts: true });
    emit({ t: "done", speech: "嗯" });
    return result({ chars: 1, usage: { prompt_tokens: 10, completion_tokens: 1 } });
  };
  const out = await runVoiceWithFallback({ text: "在吗", parts: parts() }, (e) => forwarded.push(e), stream);
  assert.equal(out.failed, false);
  assert.equal(out.speech, "嗯");
  assert.equal(out.attempts.length, 1);
  assert.equal(forwarded.filter((e) => e.t === "err" && e.tts).length, 1);
});

test("four empty strips emit a single err on the last try", async () => {
  const forwarded: TalkStreamEvent[] = [];
  const flags: Array<boolean | undefined> = [];
  const stream: VoiceStreamFn = async (data, emit) => {
    flags.push(data.failOnEmpty);
    if (!data.failOnEmpty) {
      emit({ t: "text_end", speech: "" });
      emit({ t: "err", m: TALK_FAIL.empty, status: 200, finishReason: "stop" });
    }
    return result();
  };
  const out = await runVoiceWithFallback({ text: "在吗", parts: parts() }, (e) => forwarded.push(e), stream);
  assert.equal(out.failed, true);
  assert.deepEqual(flags, [true, true, true, false]);
  assert.equal(forwarded.filter((e) => e.t === "err").length, 1);
  assert.equal(out.attempts.length, 4);
  assert.equal(out.usedStrip, "thin");
  assert.equal(out.failMessage, TALK_FAIL.empty);
});

test("recordVoiceTurn keeps diagnostics in note and raw when speech is empty", () => {
  const src = readFileSync(new URL("../voice-log.ts", import.meta.url), "utf8");
  assert.match(src, /opts\.display \|\| note/);
  assert.match(src, /firstLine\(note\)/);
  assert.doesNotMatch(src, /error: opts\.failed \? "stream-error"/);
  const talk = readFileSync(new URL("../../../../routes/api/talk.ts", import.meta.url), "utf8");
  assert.match(talk, /const failed = fallback\.failed/);
  assert.doesNotMatch(talk, /fallback\.failed \|\| failed/);
});
