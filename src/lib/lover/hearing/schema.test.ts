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
import { chooseHearing } from "./select.ts";
import { HEARING, SCRIPTED_CATEGORIES } from "./config.ts";
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
    assert.equal(tagged, "嗯〔long·rising·breathy｜coy〕今天好累〔｜sleepy〕");
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

  it("falls back to xai on timeout, refusal, schema, http", () => {
    const xai = { ok: true as const, text: "嗯", words: [], latency_ms: 12, raw: "嗯" };
    for (const reason of ["timeout", "refusal", "schema", "http"] as const) {
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
    assert.equal(picked.tagged, "嗯〔long·rising·breathy｜coy〕今天好累〔｜sleepy〕");
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

  it("applies n-best alt tags and keeps codeswitch categories", () => {
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
    assert.ok(SCRIPTED_CATEGORIES.some((c) => c.id === "codeswitch" && c.quota === 12));
    assert.ok(SCRIPTED_CATEGORIES.some((c) => c.id === "homophone" && c.quota === 10));
    assert.ok(SCRIPTED_CATEGORIES.every((c) => c.hint && c.example));
  });

  it("appends n-best and context to the hearing system prompt", () => {
    const base = hearingSystemPrompt();
    const withBoth = hearingSystemPrompt({ nbest: true, context: "对话上下文：\nRosie：在吗" });
    assert.ok(withBoth.includes(base));
    assert.ok(withBoth.includes("alternatives"));
    assert.ok(withBoth.includes("对话上下文"));
    assert.ok(!base.includes("对话上下文"));
  });
});
