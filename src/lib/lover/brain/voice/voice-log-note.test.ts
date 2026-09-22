import assert from "node:assert/strict";
import { test } from "node:test";
import { formatVoiceLogNote, type VoiceAttemptNote } from "./voice-log-note.ts";
import { parseVoiceInputCharsLine } from "./pack-build.ts";

function attempt(partial: Partial<VoiceAttemptNote> & Pick<VoiceAttemptNote, "strip">): VoiceAttemptNote {
  return {
    status: 200,
    finishReason: "stop",
    chars: 0,
    ms: 500,
    promptTokens: 100,
    completionTokens: 0,
    otherEvents: "",
    empty: true,
    ok: false,
    message: "她没说出话（空回复）",
    ...partial,
  };
}

test("formatVoiceLogNote records which strip succeeded and the char split", () => {
  const chars = { system: 10, mind: 20, notes: 30, history: 40, user: 5 };
  const note = formatVoiceLogNote({
    attempts: [
      attempt({ strip: "none" }),
      attempt({
        strip: "mind",
        chars: 8,
        ms: 800,
        promptTokens: 80,
        completionTokens: 6,
        empty: false,
        ok: true,
        message: null,
      }),
    ],
    usedStrip: "mind",
    chars,
    failed: false,
  });
  assert.match(note, /第2次成功，去掉了 mind/);
  assert.match(note, /status=200 finish_reason=stop usage prompt_tokens=80 completion_tokens=6/);
  assert.match(note, /chars system=10 mind=20 notes=30 history=40 user=5/);
  assert.match(note, /try1 未裁剪 empty/);
  assert.match(note, /try2 去掉了 mind ok/);
  assert.deepEqual(parseVoiceInputCharsLine(note), chars);
});

test("formatVoiceLogNote failed empty keeps the fail line first", () => {
  const note = formatVoiceLogNote({
    attempts: [
      attempt({ strip: "none", otherEvents: '{"choices":[{"delta":{"role":"assistant"}}]}' }),
      attempt({ strip: "mind" }),
      attempt({ strip: "notes" }),
      attempt({ strip: "thin" }),
    ],
    usedStrip: "thin",
    chars: { system: 1, mind: 2, notes: 3, history: 4, user: 5 },
    failed: true,
    failMessage: "她没说出话（空回复）",
  });
  assert.equal(note.split("\n")[0], "她没说出话（空回复）");
  assert.match(note, /第4次仍空，只保留 system prompt、最近 8 条对话和用户消息/);
  assert.match(note, /events=\{"choices"/);
  assert.match(note, /try4 只保留 system prompt、最近 8 条对话和用户消息 empty/);
});
