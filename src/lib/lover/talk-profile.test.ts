import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { nativeCallLogRow } from "./native-log.ts";
import { resolveTalkProfile } from "./talk-profile.ts";

test("a missing talk profile uses the saved persona and model", () => {
  const saved = {
    systemPrompt: "saved persona",
    voiceModel: "grok-4.6",
    voiceEffort: "high",
    voiceSpeed: 0.9,
  };
  const resolved = resolveTalkProfile(undefined, saved);
  assert.equal(resolved.systemPrompt, "saved persona");
  assert.equal(resolved.voiceModel, "grok-4.6");
  assert.equal(resolved.voiceEffort, "high");
  assert.equal(resolved.voiceSpeed, 0.9);
  const given = resolveTalkProfile({ systemPrompt: "pasted", voiceModel: "grok-4.3" }, saved);
  assert.equal(given.systemPrompt, "pasted");
  assert.equal(given.voiceModel, "grok-4.3");
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
  assert.match(talk, /getProfileData/);
  assert.doesNotMatch(talk, /lockedProfile\(body\.profile\)/);
});
