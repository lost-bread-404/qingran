import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { openIsolatedSql } from "./eval-db.ts";
import {
  dedupeActiveNotesByText,
  dedupeDuplicateAssistantReplies,
  listDuplicateActiveNoteIds,
  listDuplicateAssistantPairs,
} from "./dedupe-replies.ts";
import { upsertMessage, upsertNote } from "./store.ts";
import { loadHotContext } from "./voice/pack.ts";
import { DEFAULT_PROFILE } from "../types.ts";
import type { Note } from "./types.ts";

const TZ = "America/New_York";

function note(partial: Partial<Note> & Pick<Note, "id" | "text">): Note {
  return {
    tags: [],
    aliases: [],
    subject: "us",
    lens: ["diary"],
    fromRosie: false,
    weight: 3,
    status: "active",
    supersededBy: null,
    links: [],
    happenedAt: 1,
    localDay: "2026-09-21",
    sourceIds: [],
    recallCount: 0,
    lastRecalledAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

test("talk uses client replyId; persistReply does not write; user ids match", () => {
  const talk = readFileSync(new URL("../../../routes/api/talk.ts", import.meta.url), "utf8");
  assert.match(talk, /replyId\?: string/);
  assert.match(talk, /replyId = String\(body\.replyId \|\| ""\)\.trim\(\) \|\| newId\(\)/);
  assert.doesNotMatch(talk, /const replyId = newId\(\)/);
  const client = readFileSync(new URL("../talk-client.ts", import.meta.url), "utf8");
  assert.match(client, /replyId: string/);
  const room = readFileSync(new URL("../../../components/lover/voice-room.tsx", import.meta.url), "utf8");
  assert.match(room, /replyId: reply\.id/);
  const persist = room.slice(room.indexOf("const persistReply"), room.indexOf("const flushPaint"));
  assert.doesNotMatch(persist, /appendRoomMessage/);
  assert.match(room, /void appendRoomMessage\(\{ data: userMsg \}\)/);
});

test("one turn writes one assistant row with the client id; user rows share id", async () => {
  const iso = await openIsolatedSql();
  const t = Date.UTC(2026, 8, 21, 13, 0, 0);
  try {
    const userMsgId = "u-client";
    const replyId = "a-client";
    await iso.sql.query(
      `insert into qingran_messages (id, role, body, created_at, kind)
       values ($1, 'user', $2, $3, 'say')`,
      [userMsgId, "今晚想你", t],
    );
    const ctx = await loadHotContext({
      text: "今晚想你",
      userMsgId,
      userCreatedAt: t,
      profile: DEFAULT_PROFILE,
      nowMs: t,
      timeZone: TZ,
    });
    assert.equal(ctx.user.id, userMsgId);
    await upsertMessage({
      id: replyId,
      role: "assistant",
      text: `⟦回:${userMsgId}⟧我也想你`,
      createdAt: t + 1,
      timeZone: TZ,
    });
    const users = await iso.sql.query<{ id: string; session_id: string | null }>(
      `select id, session_id from qingran_messages where role = 'user'`,
    );
    const asst = await iso.sql.query<{ id: string; session_id: string | null }>(
      `select id, session_id from qingran_messages where role = 'assistant'`,
    );
    assert.equal(users.length, 1);
    assert.equal(users[0]!.id, userMsgId);
    assert.ok(users[0]!.session_id);
    assert.equal(asst.length, 1);
    assert.equal(asst[0]!.id, replyId);
    assert.ok(asst[0]!.session_id);

    await iso.sql.query(
      `insert into qingran_messages (id, role, body, created_at, kind)
       values ($1, 'assistant', $2, $3, 'say')`,
      ["a-client-dup", "⟦回:u-client⟧我也想你", t + 2],
    );
    const before = await listDuplicateAssistantPairs();
    assert.equal(before.length, 1, `dry-run drop count ${before.length}`);
    assert.equal(before[0]!.dropId, "a-client-dup");
    assert.equal(before[0]!.keepId, replyId);
    const ran = await dedupeDuplicateAssistantReplies();
    assert.equal(ran.dropped, 1);
    const after = await iso.sql.query<{ id: string }>(
      `select id from qingran_messages where role = 'assistant'`,
    );
    assert.equal(after.length, 1);
    assert.equal(after[0]!.id, replyId);
  } finally {
    await iso.close();
  }
});

test("duplicate notes from the same body are archived, keeping the earliest", async () => {
  const iso = await openIsolatedSql();
  try {
    await upsertNote(note({ id: "n-keep", text: "她说今晚想我", createdAt: 100, sourceIds: ["a-client"] }));
    await upsertNote(note({ id: "n-drop", text: "她说今晚想我", createdAt: 200, sourceIds: ["a-client-dup"] }));
    await upsertNote(note({ id: "n-other", text: "另一件完全不同的事", createdAt: 150 }));
    const dry = await listDuplicateActiveNoteIds();
    assert.deepEqual(dry, ["n-drop"]);
    const ran = await dedupeActiveNotesByText();
    assert.equal(ran.archived, 1);
    const active = await iso.sql.query<{ id: string; status: string }>(
      `select id, status from mem_notes where text = '她说今晚想我' order by id`,
    );
    assert.equal(active.find((r) => r.id === "n-keep")?.status, "active");
    assert.equal(active.find((r) => r.id === "n-drop")?.status, "archived");
    const other = await iso.sql.query<{ status: string }>(
      `select status from mem_notes where id = 'n-other'`,
    );
    assert.equal(other[0]!.status, "active");
  } finally {
    await iso.close();
  }
});
