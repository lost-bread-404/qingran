import assert from "node:assert/strict";
import { test } from "node:test";
import { backupFilename, makeBackup, parseBackup } from "./backup.ts";
import { DEFAULT_SYSTEM_PROMPT, lockedProfile } from "./types.ts";

test("round-trips prompt, memories, and chat", () => {
  const backup = makeBackup({
    now: 1_700_000_000_000,
    profile: lockedProfile({
      systemPrompt: "你就是清然。",
      muted: false,
      autoRemember: true,
      memoryCursor: "abc",
    }),
    memories: [{ id: "m1", text: "Rosie 怕冷", createdAt: 1, updatedAt: 2 }],
    messages: [
      { id: "u1", role: "user", text: "在吗", createdAt: 3, voiceTurnId: "turn-1" },
      { id: "a1", role: "assistant", text: "在。", createdAt: 4 },
    ],
  });
  const parsed = parseBackup(JSON.parse(JSON.stringify(backup)));
  assert.ok(parsed);
  assert.equal(parsed.profile.systemPrompt, "你就是清然。");
  assert.equal(parsed.profile.memoryCursor, "abc");
  assert.equal(parsed.profile.debugHearing, true);
  assert.equal(parsed.profile.hearingNbest, false);
  assert.equal(parsed.profile.silenceMs, 1500);
  assert.equal(parsed.memories[0]?.text, "Rosie 怕冷");
  assert.equal(parsed.messages[1]?.text, "在。");
  assert.equal(parsed.messages[0]?.voiceTurnId, "turn-1");
});

test("rejects random json so a wrong file cannot wipe the room", () => {
  assert.equal(parseBackup({ foo: 1 }), null);
  assert.equal(parseBackup(null), null);
  assert.equal(parseBackup({ kind: "qingran-backup", version: 99, memories: [], messages: [] }), null);
});

test("empty prompt in a backup still becomes the default after lock", () => {
  const parsed = parseBackup(
    makeBackup({
      profile: lockedProfile({ systemPrompt: "", muted: false, autoRemember: true, memoryCursor: "" }),
      memories: [],
      messages: [],
    }),
  );
  assert.ok(parsed);
  assert.equal(parsed.profile.systemPrompt, DEFAULT_SYSTEM_PROMPT);
});

test("debug switch owns captureAudio", () => {
  assert.equal(lockedProfile({ debugHearing: false }).debugHearing, false);
  assert.equal(lockedProfile({ debugHearing: false }).captureAudio, false);
  assert.equal(lockedProfile({ debugHearing: true, captureAudio: false }).captureAudio, true);
  assert.equal(lockedProfile({ debugHearing: false, captureAudio: true }).captureAudio, false);
});

test("round-trips confirmed gold flag on a voice turn", () => {
  const backup = makeBackup({
    now: 1_700_000_000_000,
    profile: lockedProfile({ debugHearing: true }),
    memories: [],
    messages: [
      {
        id: "u1",
        role: "user",
        text: "嗯",
        createdAt: 3,
        voiceTurnId: "turn-9",
        hearingGold: "confirmed",
      },
    ],
  });
  const parsed = parseBackup(JSON.parse(JSON.stringify(backup)));
  assert.equal(parsed?.messages[0]?.hearingGold, "confirmed");
  assert.equal(parsed?.messages[0]?.voiceTurnId, "turn-9");
});

test("round-trips unheard kind and replyTo", () => {
  const backup = makeBackup({
    now: 1_700_000_000_000,
    profile: lockedProfile({ debugHearing: true }),
    memories: [],
    messages: [
      { id: "u0", role: "user", text: "〔未识别〕", createdAt: 2, kind: "unheard", voiceTurnId: "turn-0" },
      { id: "u1", role: "user", text: "在吗", createdAt: 3 },
      { id: "a1", role: "assistant", text: "在。", createdAt: 4, replyTo: "u1" },
    ],
  });
  const parsed = parseBackup(JSON.parse(JSON.stringify(backup)));
  assert.equal(parsed?.messages[0]?.kind, "unheard");
  assert.equal(parsed?.messages[2]?.replyTo, "u1");
});

test("round-trips interrupted assistant replies", () => {
  const backup = makeBackup({
    now: 1_700_000_000_000,
    profile: lockedProfile(),
    memories: [],
    messages: [
      { id: "u1", role: "user", text: "听我说", createdAt: 3 },
      { id: "a1", role: "assistant", text: "我正要说完", createdAt: 4, interrupted: true },
    ],
  });
  const parsed = parseBackup(JSON.parse(JSON.stringify(backup)));
  assert.equal(parsed?.messages[1]?.interrupted, true);
  assert.equal(parsed?.messages[1]?.text, "我正要说完");
});

test("backup filename is a dated json", () => {
  assert.match(backupFilename(Date.UTC(2026, 8, 16)), /^qingran-backup-\d{8}\.json$/);
});

test("migrates legacy voiceChat into voiceModel and voiceEffort", () => {
  assert.equal(lockedProfile({ voiceChat: "4.3-low" }).voiceModel, "grok-4.3");
  assert.equal(lockedProfile({ voiceChat: "4.3-low" }).voiceEffort, "low");
  assert.equal(lockedProfile({ voiceChat: "4.3-medium" }).voiceModel, "grok-4.3");
  assert.equal(lockedProfile({ voiceChat: "4.3-medium" }).voiceEffort, "medium");
  assert.equal(lockedProfile({ voiceChat: "4.20" }).voiceModel, "grok-4.20-0309-non-reasoning");
  assert.equal(lockedProfile({ voiceChat: "4.20" }).voiceEffort, null);
  assert.equal(lockedProfile({ voiceModel: "grok-4.5", voiceEffort: "high" }).voiceModel, "grok-4.5");
  assert.equal(lockedProfile({ voiceModel: "grok-4.5", voiceEffort: "high" }).voiceEffort, "high");
  assert.equal(lockedProfile().voiceModel, "grok-4.3");
  assert.equal(lockedProfile().voiceEffort, "low");
  assert.equal(lockedProfile().injectMemories, true);
  assert.equal(lockedProfile().injectLongterm, true);
  assert.equal(lockedProfile().historyWindow, 40);
  assert.equal(lockedProfile({ injectMemories: false, injectLongterm: false, historyWindow: 0 }).historyWindow, 0);
  assert.equal(lockedProfile({ historyWindow: 99 }).historyWindow, 80);
  assert.equal(lockedProfile({ injectMemories: false }).injectMemories, false);
});
