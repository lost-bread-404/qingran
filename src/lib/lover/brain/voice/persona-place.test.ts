import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_INNER } from "../types.ts";
import { intimateNotesForVoice } from "../mind-parse.ts";
import { SESSION_GAP_MS } from "../config.ts";
import { buildVoiceMessages, insertIntimateNotes, placePersona } from "./pack-build.ts";

const history = [
  { id: "u1", role: "user" as const, text: "嗯", createdAt: 1, kind: "say" as const, archivedAt: null, sessionId: "s", localDay: "2026-09-15" },
];

test("system placement keeps the persona inside the first system message", () => {
  const msgs = buildVoiceMessages({
    charter: "PERSONA_LINE",
    history,
    userText: "今晚",
    clock: "星期二 21:00",
    personaPlacement: "system",
  });
  assert.match(msgs[0]!.content, /PERSONA_LINE/);
  assert.equal(msgs.some((m) => m.role === "assistant" && m.content === "嗯。"), false);
  const userAt = msgs.findIndex((m) => m.content === "嗯");
  assert.equal(msgs[userAt - 1]?.role, "system");
});

test("first_user puts the persona before history and an ack, not in system", () => {
  const msgs = buildVoiceMessages({
    charter: "PERSONA_LINE",
    history,
    userText: "今晚",
    clock: "星期二 21:00",
    personaPlacement: "first_user",
    personaAck: "嗯。",
  });
  assert.equal(msgs.some((m) => m.role === "system" && m.content.includes("PERSONA_LINE")), false);
  const persona = msgs.findIndex((m) => m.role === "user" && m.content === "PERSONA_LINE");
  assert.ok(persona >= 0);
  assert.equal(msgs[persona + 1]?.role, "assistant");
  assert.equal(msgs[persona + 1]?.content, "嗯。");
  const hist = msgs.findIndex((m) => m.content === "嗯");
  const current = msgs.findIndex((m) => m.content === "今晚");
  assert.ok(persona < hist && hist < current);
});

test("intimate notes are injected only for a fresh intimate scene", () => {
  const now = 1_000_000;
  const fresh = { ...EMPTY_INNER, scene: "intimate" as const, updated_at: now - 1000 };
  const daily = { ...EMPTY_INNER, scene: "daily" as const, updated_at: now - 1000 };
  const stale = { ...EMPTY_INNER, scene: "intimate" as const, updated_at: now - SESSION_GAP_MS - 1 };
  assert.equal(intimateNotesForVoice(fresh, now, "想被抱着"), "想被抱着");
  assert.equal(intimateNotesForVoice(daily, now, "想被抱着"), "");
  assert.equal(intimateNotesForVoice(stale, now, "想被抱着"), "");
  assert.equal(intimateNotesForVoice(fresh, now, "  "), "");
  const msgs = insertIntimateNotes(
    [{ role: "system" as const, content: "【我此刻】\n心里：想" }, { role: "user" as const, content: "今晚" }],
    "想被抱着",
  );
  assert.match(msgs[1]!.content, /【此刻的我】/);
  assert.match(msgs[1]!.content, /想被抱着/);
  assert.equal(placePersona(msgs, { placement: "system", charter: "P", ack: "嗯。" }).length, msgs.length);
});
