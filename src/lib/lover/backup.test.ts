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

test("backup filename is a dated json", () => {
  assert.match(backupFilename(Date.UTC(2026, 8, 16)), /^qingran-backup-\d{8}\.json$/);
});
