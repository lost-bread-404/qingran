import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatTaggedText,
  looksLikeRefusal,
  parseHearingJson,
  stripCueTags,
  type HearingModelOutput,
} from "./schema.ts";
import { assignSplits } from "./split.ts";
import { cer, cueTokenF1, fieldAccuracy, selfConsistency } from "./metrics.ts";
import { chooseHearing, formatEngineLine, aggregateEngineUse, formatEngineMix, formatEngineErrorDetail, engineErrorDetailFromOutcome, engineLineFromHeard, redactEngineSecrets, ENGINE_ERROR_BODY_MAX, ENGINE_ERROR_DISPLAY_MAX } from "./select.ts";
import { HEARING } from "./config.ts";
import { classifyGeminiResponse, clipFallbackRaw, hearingSystemPrompt, isModerationHttpError } from "./http.ts";

describe("hearing schema", () => {
  it("parses strict json and tagged text", () => {
    const raw = JSON.stringify({
      text: "嗯今天好累",
      cues: [
        {
          token: "嗯",
          contour: "rising",
          length: "long",
          voice: "breathy",
          emotion: "coy",
        },
      ],
      utterance_emotion: "sleepy",
      noise_only: false,
    });
    const parsed = parseHearingJson(raw);
    assert.equal(parsed.cues[0]?.token, "嗯");
    const tagged = formatTaggedText(parsed);
    assert.equal(tagged, "嗯今天好累〔long·rising·breathy｜〕");
    assert.equal(stripCueTags(tagged), "嗯今天好累");
  });

  it("rejects bad contour", () => {
    assert.throws(() =>
      parseHearingJson(
        JSON.stringify({
          text: "嗯",
          cues: [{ token: "嗯", contour: "up", length: "short", voice: "normal", emotion: "neutral" }],
          utterance_emotion: "neutral",
          noise_only: false,
        }),
      ),
    );
  });

  it("detects refusal text", () => {
    assert.equal(looksLikeRefusal("Sorry, I cannot transcribe this."), true);
    assert.equal(looksLikeRefusal('{"text":"嗯","cues":[],"utterance_emotion":"neutral","noise_only":false}'), false);
  });

  it("falls back to xai on timeout, refusal, schema, http, missing_key", () => {
    const xai = { ok: true as const, text: "嗯", words: [], latency_ms: 12, raw: "嗯" };
    for (const reason of ["timeout", "refusal", "schema", "http", "missing_key"] as const) {
      const picked = chooseHearing({
        provider: "qwen",
        outcome: { ok: false, reason, latency_ms: 4000, provider: "qwen", model: HEARING.qwen.model },
        xai,
      });
      assert.equal(picked.fallback, true);
      assert.equal(picked.used, "xai");
      assert.equal(picked.fallback_reason, reason);
      assert.equal(picked.tagged, "嗯");
      assert.equal(picked.refusal, reason === "refusal");
    }
  });

  it("records fallback reason on the debug engine line", () => {
    assert.equal(formatEngineLine({ used: "gemini" }), "引擎：gemini");
    assert.equal(formatEngineLine({ used: "xai" }), "引擎：xai");
    assert.equal(
      formatEngineLine({ used: "xai", fallback: true, fallbackReason: "timeout" }),
      "引擎：xai(fallback: timeout)",
    );
    assert.equal(
      formatEngineLine({ used: "xai", fallback: true, fallbackReason: "refusal" }),
      "引擎：xai(fallback: refused)",
    );
    assert.equal(
      formatEngineLine({ used: "xai", fallback: true, fallbackReason: "schema" }),
      "引擎：xai(fallback: error)",
    );
    assert.equal(
      formatEngineLine({ used: "xai", fallback: true, fallbackReason: "http" }),
      "引擎：xai(fallback: error)",
    );
    assert.equal(
      formatEngineLine({
        used: "xai",
        fallback: true,
        fallbackReason: "http",
        errorDetail: "503 {\"error\":\"UNAVAILABLE\"}",
      }),
      "引擎：xai(fallback: error) 503 {\"error\":\"UNAVAILABLE\"}",
    );
    assert.equal(
      formatEngineLine({
        used: "xai",
        fallback: true,
        fallbackReason: "timeout",
        errorDetail: "503 nope",
      }),
      "引擎：xai(fallback: timeout)",
    );
    assert.equal(
      formatEngineLine({ used: "xai", fallback: true, fallbackReason: "missing_key" }),
      "引擎：xai(fallback: missing_key)",
    );
    assert.equal(formatEngineLine({ used: "xai", fallback: true }), "引擎：xai");
    assert.equal(
      engineLineFromHeard({
        engineRequested: "gemini",
        engineUsed: "xai",
        engineFallback: "http",
        engineErrorDetail: "503 overloaded",
      }),
      "当前引擎：gemini（会拖慢识别） · 引擎：xai(fallback: error) 503 overloaded",
    );
  });

  it("records http status and a 500-char body snippet on http fallback", () => {
    assert.equal(formatEngineErrorDetail(503, '{"error":"UNAVAILABLE"}'), '503 {"error":"UNAVAILABLE"}');
    assert.equal(formatEngineErrorDetail(429, ""), "429");
    assert.equal(formatEngineErrorDetail(undefined, "fetch failed"), "fetch failed");
    assert.equal(formatEngineErrorDetail(null, null), null);
    const body = "x".repeat(800);
    const detail = formatEngineErrorDetail(502, body);
    assert.equal(detail, `502 ${"x".repeat(ENGINE_ERROR_BODY_MAX)}`);
    assert.equal(detail?.length, 4 + ENGINE_ERROR_BODY_MAX);
    assert.equal(
      engineErrorDetailFromOutcome({
        ok: false,
        reason: "http",
        status: 503,
        raw: '{"error":"overloaded"}',
        latency_ms: 12,
        provider: "gemini",
        model: HEARING.gemini.model,
      }),
      '503 {"error":"overloaded"}',
    );
    assert.equal(
      engineErrorDetailFromOutcome({
        ok: false,
        reason: "timeout",
        status: 408,
        raw: "timed out",
        latency_ms: 8000,
        provider: "qwen",
        model: HEARING.qwen.model,
      }),
      null,
    );
    assert.equal(engineErrorDetailFromOutcome(null), null);
    const secretBody = 'Bearer sk-supersecretkeyvalue {"api_key":"AIzaSyDummyKeyThatLooksReal0001"}';
    const redacted = redactEngineSecrets(secretBody);
    assert.doesNotMatch(redacted, /sk-supersecretkeyvalue/);
    assert.doesNotMatch(redacted, /AIzaSyDummyKeyThatLooksReal0001/);
    assert.match(redacted, /\[redacted\]/);
    assert.doesNotMatch(formatEngineErrorDetail(401, secretBody) ?? "", /sk-supersecretkeyvalue/);
    const long = `503 ${"y".repeat(200)}`;
    assert.equal(
      formatEngineLine({
        used: "xai",
        fallback: true,
        fallbackReason: "http",
        errorDetail: long,
      }),
      `引擎：xai(fallback: error) ${long.slice(0, ENGINE_ERROR_DISPLAY_MAX)}`,
    );
  });

  it("mixes engine use and fallback reasons for the lab card", () => {
    const stats = aggregateEngineUse([
      { engine: "gemini", reason: null, n: 6 },
      { engine: "xai", reason: "timeout", n: 3 },
      { engine: "xai", reason: "refusal", n: 1 },
    ]);
    assert.equal(stats.n, 10);
    assert.deepEqual(stats.used, [
      { engine: "gemini", n: 6 },
      { engine: "xai", n: 4 },
    ]);
    assert.deepEqual(stats.fallback, [
      { reason: "timeout", n: 3 },
      { reason: "refused", n: 1 },
    ]);
    assert.equal(formatEngineMix(stats), "gemini 60% · xai 40% · 退回 timeout 3 · refused 1");
    assert.equal(formatEngineMix({ n: 0, used: [], fallback: [] }), "无数据");
  });

  it("keeps audio-llm result when schema is valid", () => {
    const picked = chooseHearing({
      provider: "gemini",
      outcome: {
        ok: true,
        result: {
          text: "嗯今天好累",
          cues: [
            { token: "嗯", contour: "rising", length: "long", voice: "breathy", emotion: "coy" },
          ],
          utterance_emotion: "sleepy",
          noise_only: false,
          raw: "{}",
          latency_ms: 900,
          provider: "gemini",
          model: HEARING.gemini.model,
          refusal: false,
        },
      },
      xai: { ok: true, text: "嗯 今天好累", words: [], latency_ms: 400, raw: "嗯 今天好累" },
    });
    assert.equal(picked.fallback, false);
    assert.equal(picked.used, "gemini");
    assert.equal(picked.tagged, "嗯今天好累〔long·rising·breathy｜〕");
  });

  it("stratifies splits 70/30 per category", () => {
    const clips = [
      ...Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, category: "en" })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, category: "coy" })),
    ];
    const map = assignSplits(clips, 0.7, 7);
    const en = clips.filter((c) => c.category === "en");
    const enDev = en.filter((c) => map.get(c.id) === "dev").length;
    assert.equal(enDev, 7);
    assert.equal([...map.values()].filter((s) => s === "test").length, 6);
  });

  it("computes cer and cue f1", () => {
    assert.equal(cer("嗯今天", "嗯今天"), 0);
    const gold = [
      { token: "嗯", contour: "rising" as const, length: "long" as const, voice: "breathy" as const, emotion: "coy" as const },
    ];
    const pred = [
      { token: "嗯", contour: "rising" as const, length: "short" as const, voice: "normal" as const, emotion: "coy" as const },
    ];
    assert.equal(cueTokenF1(gold, pred).f1, 1);
    assert.equal(fieldAccuracy(gold, pred, "contour"), 1);
    assert.equal(fieldAccuracy(gold, pred, "emotion"), 1);
  });

  it("self-consistency agrees on identical gold", () => {
    const gold: HearingModelOutput = {
      text: "嗯",
      cues: [
        {
          token: "嗯",
          contour: "rising",
          length: "long",
          voice: "breathy",
          emotion: "coy",
        },
      ],
      utterance_emotion: "coy",
      noise_only: false,
    };
    const score = selfConsistency(gold, gold);
    assert.equal(score.textAgree, 1);
    assert.equal(score.tokens, 1);
    assert.equal(score.noise, 1);
  });

  it("classifies dashscope inspection 400 as refusal", () => {
    const raw = JSON.stringify({
      error: { code: "data_inspection_failed", message: "Input data may contain inappropriate content." },
    });
    assert.equal(isModerationHttpError(400, raw), true);
    assert.equal(isModerationHttpError(400, "DataInspectionFailed"), true);
    assert.equal(isModerationHttpError(400, "IPInfringementSuspect"), true);
    assert.equal(isModerationHttpError(400, "InternalError.Algo.DataInspectionFailed"), true);
    assert.equal(isModerationHttpError(400, "The audio format is illegal"), false);
    assert.equal(isModerationHttpError(422, raw), false);
  });

  it("classifies gemini SAFETY as refusal and MAX_TOKENS as schema", () => {
    assert.equal(classifyGeminiResponse({ promptFeedback: { blockReason: "SAFETY" } }), "refusal");
    assert.equal(classifyGeminiResponse({ candidates: [{ finishReason: "SAFETY" }] }), "refusal");
    assert.equal(classifyGeminiResponse({ candidates: [{ finishReason: "MAX_TOKENS" }] }), "schema");
    assert.equal(classifyGeminiResponse({ candidates: [{ finishReason: "STOP" }] }), "ok");
    assert.equal(clipFallbackRaw("x".repeat(2500))?.length, 2000);
  });

  it("applies n-best alt tags", () => {
    const parsed = parseHearingJson(
      JSON.stringify({
        text: "今天好累",
        cues: [],
        utterance_emotion: "neutral",
        noise_only: false,
        alternatives: [{ span: "天", candidates: ["天", "填"] }],
      }),
    );
    assert.equal(formatTaggedText(parsed), "今{天|填}好累");
  });

  it("appends n-best and context to the hearing system prompt", () => {
    const base = hearingSystemPrompt();
    const withBoth = hearingSystemPrompt({ nbest: true, context: "对话上下文：\nRosie：在吗" });
    assert.ok(withBoth.includes(base));
    assert.ok(withBoth.includes("alternatives"));
    assert.ok(withBoth.includes("对话上下文"));
    assert.ok(!base.includes("对话上下文"));
    const custom = hearingSystemPrompt({ instruction: "只转写，不要标签。" });
    assert.match(custom, /^只转写，不要标签。/);
    assert.doesNotMatch(custom, /你是中文口语转写器/);
  });
});
