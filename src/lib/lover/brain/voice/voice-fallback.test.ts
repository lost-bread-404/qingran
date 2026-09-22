import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EMPTY_MIND } from "../types.ts";
import { classifyVoiceModelFallback, runVoiceWithFallback, type VoiceStreamFn } from "./voice-fallback.ts";
import type { VoicePackParts } from "./pack-build.ts";
import type { TalkStreamEvent, TalkStreamResult } from "../../stream-talk.ts";
import { TALK_FAIL } from "../../talk-fail.ts";
import type { VoiceModelPick } from "../config.ts";

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

const primary: VoiceModelPick = { model: "primary-model", effort: "low", timeoutMs: 60_000 };
const safety: VoiceModelPick = { model: "safety-model", effort: null, timeoutMs: 28_000 };

function result(partial: Partial<TalkStreamResult> = {}): TalkStreamResult {
  return {
    usage: { prompt_tokens: 80, completion_tokens: 0 },
    ttftMs: null,
    firstAudioMs: null,
    model: "primary-model",
    effort: "low",
    ttsChars: 0,
    status: 200,
    finishReason: "stop",
    ms: 500,
    chars: 0,
    otherEvents: '{"choices":[{"delta":{"role":"assistant"}}]}',
    ...partial,
  };
}

function run(
  stream: VoiceStreamFn,
  emit: (e: TalkStreamEvent) => void = () => undefined,
  picks: { primary?: VoiceModelPick; safety?: VoiceModelPick } = {},
) {
  return runVoiceWithFallback(
    { text: "在吗", parts: parts(), primary: picks.primary ?? primary, safety: picks.safety ?? safety },
    emit,
    stream,
  );
}

function speak(streamResult: TalkStreamResult, emit: (e: TalkStreamEvent) => void, text = "在") {
  emit({ t: "text", d: text });
  emit({ t: "text_end", speech: text });
  emit({ t: "done", speech: text, status: 200, finishReason: "stop", ms: streamResult.ms, chars: text.length });
  return streamResult;
}

test("empty primary retries the safety model before stripping mind", async () => {
  const models: string[] = [];
  const forwarded: TalkStreamEvent[] = [];
  const stream: VoiceStreamFn = async (data, emit) => {
    models.push(data.model ?? "");
    if (models.length === 1) return result({ ttftMs: 4100 });
    return speak(
      result({
        model: "safety-model",
        effort: null,
        usage: { prompt_tokens: 40, completion_tokens: 2 },
        chars: 1,
        ms: 800,
        ttftMs: 320,
        otherEvents: "",
      }),
      emit,
    );
  };
  const out = await run(stream, (e) => forwarded.push(e));
  assert.equal(out.failed, false);
  assert.equal(out.speech, "在");
  assert.equal(out.usedStrip, "none");
  assert.equal(out.attempts.length, 2);
  assert.deepEqual(models, ["primary-model", "safety-model"]);
  assert.equal(out.modelFallback?.reason, "empty");
  assert.equal(out.modelFallback?.from, "primary-model/low");
  assert.equal(out.modelFallback?.to, "safety-model/none");
  assert.equal(out.attempts[0]?.ttftMs, 4100);
  assert.equal(out.attempts[1]?.ttftMs, 320);
  assert.equal(forwarded.some((e) => e.t === "err"), false);
});

test("http error on primary also retries safety once", async () => {
  const models: string[] = [];
  const stream: VoiceStreamFn = async (data, emit) => {
    models.push(data.model ?? "");
    if (models.length === 1) {
      emit({ t: "err", m: "想你的时候卡住了（500）。", status: 500 });
      return result({ status: 500, model: "primary-model", otherEvents: "internal" });
    }
    return speak(result({ model: "safety-model", effort: null, chars: 1, otherEvents: "" }), emit, "嗯");
  };
  const out = await run(stream);
  assert.equal(out.failed, false);
  assert.equal(out.speech, "嗯");
  assert.match(out.modelFallback?.reason ?? "", /http_error 500/);
  assert.deepEqual(models, ["primary-model", "safety-model"]);
});

test("timeout on primary retries safety once", async () => {
  const models: string[] = [];
  const stream: VoiceStreamFn = async (data, emit) => {
    models.push(data.model ?? "");
    if (models.length === 1) {
      const err = new Error("aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    }
    return speak(result({ model: "safety-model", effort: null, chars: 1, otherEvents: "" }), emit);
  };
  const out = await run(stream);
  assert.equal(out.failed, false);
  assert.equal(out.speech, "在");
  assert.equal(out.modelFallback?.reason, "timeout");
  assert.deepEqual(models, ["primary-model", "safety-model"]);
});

test("both models empty then strip mind on primary", async () => {
  const bodies: string[] = [];
  const models: string[] = [];
  const forwarded: TalkStreamEvent[] = [];
  const stream: VoiceStreamFn = async (data, emit) => {
    models.push(data.model ?? "");
    bodies.push(data.messages.map((m) => m.content).join("\n"));
    if (models.length < 3) return result({ model: data.model ?? "" });
    return speak(
      result({
        model: data.model ?? "",
        usage: { prompt_tokens: 40, completion_tokens: 2 },
        chars: 1,
        ms: 800,
        otherEvents: "",
      }),
      emit,
    );
  };
  const out = await run(stream, (e) => forwarded.push(e));
  assert.equal(out.failed, false);
  assert.equal(out.speech, "在");
  assert.equal(out.usedStrip, "mind");
  assert.equal(out.attempts.length, 3);
  assert.deepEqual(models, ["primary-model", "safety-model", "primary-model"]);
  assert.match(bodies[0]!, /你此刻的内心|她现在/);
  assert.match(bodies[1]!, /你此刻的内心|她现在/);
  assert.doesNotMatch(bodies[2]!, /你此刻的内心|她现在：/);
  assert.equal(forwarded.some((e) => e.t === "err"), false);
});

test("primary empty then safety http still strips mind on primary", async () => {
  const models: string[] = [];
  const stream: VoiceStreamFn = async (data, emit) => {
    models.push(data.model ?? "");
    if (models.length === 1) return result();
    if (models.length === 2) {
      emit({ t: "err", m: "想你的时候卡住了（500）。", status: 500 });
      return result({ status: 500, model: "safety-model", effort: null, otherEvents: "internal" });
    }
    return speak(result({ model: data.model ?? "", chars: 1, otherEvents: "" }), emit);
  };
  const out = await run(stream);
  assert.equal(out.failed, false);
  assert.equal(out.usedStrip, "mind");
  assert.equal(out.modelFallback?.reason, "empty");
  assert.deepEqual(models, ["primary-model", "safety-model", "primary-model"]);
});

test("same model skip safety and only strip content", async () => {
  const models: string[] = [];
  const flags: Array<boolean | undefined> = [];
  const stream: VoiceStreamFn = async (data, emit) => {
    models.push(data.model ?? "");
    flags.push(data.failOnEmpty);
    if (models.length < 2) return result({ model: data.model ?? "" });
    return speak(result({ model: data.model ?? "", chars: 1, otherEvents: "" }), emit);
  };
  const out = await run(stream, () => undefined, { primary, safety: primary });
  assert.equal(out.failed, false);
  assert.equal(out.usedStrip, "mind");
  assert.equal(out.modelFallback, null);
  assert.deepEqual(models, ["primary-model", "primary-model"]);
  assert.deepEqual(flags, [true, true]);
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
  const out = await run(stream, (e) => forwarded.push(e));
  assert.equal(out.failed, false);
  assert.equal(out.speech, "嗯");
  assert.equal(out.attempts.length, 1);
  assert.equal(out.modelFallback, null);
  assert.equal(forwarded.filter((e) => e.t === "err" && e.tts).length, 1);
});

test("four empty strips emit a single err on the last try after one safety retry", async () => {
  const forwarded: TalkStreamEvent[] = [];
  const flags: Array<boolean | undefined> = [];
  const stream: VoiceStreamFn = async (data, emit) => {
    flags.push(data.failOnEmpty);
    if (!data.failOnEmpty) {
      emit({ t: "text_end", speech: "" });
      emit({ t: "err", m: TALK_FAIL.empty, status: 200, finishReason: "stop" });
    }
    return result({ model: data.model ?? "" });
  };
  const out = await run(stream, (e) => forwarded.push(e));
  assert.equal(out.failed, true);
  assert.deepEqual(flags, [true, true, true, true, false]);
  assert.equal(forwarded.filter((e) => e.t === "err").length, 1);
  assert.equal(out.attempts.length, 5);
  assert.equal(out.usedStrip, "thin");
  assert.equal(out.failMessage, TALK_FAIL.empty);
  assert.equal(out.modelFallback?.reason, "empty");
});

test("classifyVoiceModelFallback names empty, http, timeout", () => {
  assert.equal(
    classifyVoiceModelFallback({ status: 200, finishReason: "stop", speech: "", failMessage: null }),
    "empty",
  );
  assert.match(
    classifyVoiceModelFallback({
      status: 500,
      finishReason: null,
      speech: "",
      failMessage: "想你的时候卡住了（500）。",
      otherEvents: "internal boom",
    }),
    /http_error 500 internal boom/,
  );
  assert.equal(
    classifyVoiceModelFallback({
      status: null,
      finishReason: null,
      speech: "",
      failMessage: TALK_FAIL.timeout,
    }),
    "timeout",
  );
});

test("recordVoiceTurn keeps diagnostics in note and raw when speech is empty", () => {
  const src = readFileSync(new URL("../voice-log.ts", import.meta.url), "utf8");
  assert.match(src, /opts\.display \|\| note/);
  assert.match(src, /firstLine\(note\)/);
  assert.doesNotMatch(src, /error: opts\.failed \? "stream-error"/);
  const talk = readFileSync(new URL("../../../../routes/api/talk.ts", import.meta.url), "utf8");
  assert.match(talk, /const failed = fallback\.failed/);
  assert.match(talk, /resolveVoiceChat/);
  assert.match(talk, /voiceSafetyPick/);
  assert.match(talk, /modelFallback: fallback\.modelFallback/);
  assert.doesNotMatch(talk, /fallback\.failed \|\| failed/);
});
