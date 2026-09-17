import assert from "node:assert/strict";
import { test } from "node:test";
import { setClock } from "./clock.ts";
import { openIsolatedSql } from "./eval-db.ts";
import { messageAsOf, noteAsOf } from "./as-of.ts";
import { updateMessageText, upsertMessage, upsertNote } from "./store.ts";
import type { Note } from "./types.ts";

const TZ = "America/New_York";

function note(partial: Partial<Note> & Pick<Note, "id" | "text">): Note {
  return {
    tags: ["测"],
    subject: "rosie",
    lens: ["diary"],
    fromRosie: true,
    weight: 3,
    status: "active",
    supersededBy: null,
    links: [],
    happenedAt: 1,
    localDay: "2026-09-16",
    sourceIds: [],
    recallCount: 0,
    lastRecalledAt: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...partial,
  };
}

test("noteAsOf and messageAsOf restore text at t after later edits", async () => {
  const iso = await openIsolatedSql();
  try {
    setClock(() => 2_000);
    await upsertNote(note({ id: "n1", text: "原文", createdAt: 1_000, updatedAt: 2_000 }));
    setClock(() => 5_000);
    await upsertNote(note({ id: "n1", text: "改过了", createdAt: 1_000, updatedAt: 5_000 }));
    const atCall = await noteAsOf("n1", 3_000);
    assert.equal(atCall?.text, "原文");
    const now = await noteAsOf("n1", 6_000);
    assert.equal(now?.text, "改过了");
    assert.equal(await noteAsOf("n1", 500), null);

    setClock(() => 2_000);
    await upsertMessage({ id: "m1", role: "user", text: "你好", createdAt: 1_500, timeZone: TZ });
    setClock(() => 8_000);
    await updateMessageText("m1", "你好呀");
    const old = await messageAsOf("m1", 3_000);
    assert.equal(old?.text, "你好");
    const latest = await messageAsOf("m1", 9_000);
    assert.equal(latest?.text, "你好呀");
  } finally {
    setClock(null);
    await iso.close();
  }
});
