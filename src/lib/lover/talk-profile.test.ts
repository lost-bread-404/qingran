import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildVoiceMessages } from "./brain/voice/pack-build.ts";
import { nativeCallLogRow } from "./native-log.ts";
import { NEUTRAL_PERSONA } from "./types.ts";
import { resolveTalkProfile } from "./talk-profile.ts";

function systemOf(charter: string): string {
  return buildVoiceMessages({
    charter,
    history: [],
    userText: "在吗",
    clock: "现在",
  })
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
}

test("talk uses the saved persona even when the client omits or replaces it", () => {
  const saved = {
    systemPrompt: "数据库里的人设",
    voiceModel: "grok-4.6",
    voiceEffort: "high",
    voiceSpeed: 0.9,
    injectMind: true,
    historyWindow: 12,
  };
  const missing = resolveTalkProfile(undefined, saved);
  assert.equal(missing.personaMissing, false);
  assert.equal(missing.profile.systemPrompt, "数据库里的人设");
  assert.equal(missing.profile.voiceModel, "grok-4.6");
  assert.equal(missing.profile.voiceEffort, "high");
  assert.match(systemOf(missing.profile.systemPrompt), /数据库里的人设/);

  for (const given of [{}, { systemPrompt: "" }, { systemPrompt: "   " }, { systemPrompt: "客户端临时的" }]) {
    const resolved = resolveTalkProfile(given, saved);
    assert.equal(resolved.personaMissing, false);
    assert.equal(resolved.profile.systemPrompt, "数据库里的人设");
    const system = systemOf(resolved.profile.systemPrompt);
    assert.match(system, /数据库里的人设/);
    assert.doesNotMatch(system, /客户端临时的/);
    assert.doesNotMatch(system, /语音通话/);
  }
});

test("playback can follow the client; model and injection stay on the saved profile", () => {
  const resolved = resolveTalkProfile(
    { voiceSpeed: 1.2, muted: true, voiceModel: "grok-4.20", injectMind: false, historyWindow: 0, systemPrompt: "临时" },
    { systemPrompt: "数据库里的人设", voiceModel: "grok-4.3", voiceEffort: "medium", voiceSpeed: 0.8, injectMind: true, historyWindow: 20 },
  );
  assert.equal(resolved.profile.voiceSpeed, 1.2);
  assert.equal(resolved.profile.muted, true);
  assert.equal(resolved.profile.voiceModel, "grok-4.3");
  assert.equal(resolved.profile.voiceEffort, "medium");
  assert.equal(resolved.profile.injectMind, true);
  assert.equal(resolved.profile.historyWindow, 20);
  assert.equal(resolved.profile.systemPrompt, "数据库里的人设");
});

test("an empty saved persona does not become the old call prompt", () => {
  const resolved = resolveTalkProfile(
    { systemPrompt: "你就是清然。正在和 Rosie 语音通话。" },
    {},
  );
  assert.equal(resolved.personaMissing, true);
  assert.equal(resolved.profile.systemPrompt, NEUTRAL_PERSONA);
  assert.doesNotMatch(resolved.profile.systemPrompt, /通话|电话|手机/);
  assert.match(systemOf(resolved.profile.systemPrompt), /你是清然。/);
  assert.doesNotMatch(systemOf(resolved.profile.systemPrompt), /语音通话/);
});

test("native call log keeps a short error and never invents success", () => {
  assert.deepEqual(nativeCallLogRow({ ok: true, ms: 12.2, note: "up", error: "" }), {
    ok: true,
    ms: 12,
    error: null,
    note: "up",
  });
  const row = nativeCallLogRow({ error: "x".repeat(800) });
  assert.equal(row.ok, false);
  assert.equal(row.error?.length, 500);
  assert.equal(row.ms, null);
});

test("stt and native-log routes are gated and write brain_log", () => {
  const stt = readFileSync(new URL("../../routes/api/stt.ts", import.meta.url), "utf8");
  const log = readFileSync(new URL("../../routes/api/native-log.ts", import.meta.url), "utf8");
  const talk = readFileSync(new URL("../../routes/api/talk.ts", import.meta.url), "utf8");
  assert.match(stt, /transcribeVoiceAudio/);
  assert.match(stt, /step: "stt"/);
  assert.match(stt, /appendBrainLog/);
  assert.match(log, /step: "native-call"/);
  assert.match(log, /nativeCallLogRow/);
  assert.match(talk, /resolveTalkProfile/);
  assert.match(talk, /getProfileData\(\)/);
  assert.match(talk, /persona_missing/);
  assert.doesNotMatch(talk, /body\.profile == null \? await getProfileData/);
  assert.doesNotMatch(talk, /lockedProfile\(body\.profile\)/);
});
