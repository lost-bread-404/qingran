import assert from "node:assert/strict";
import { test } from "node:test";
import { openIsolatedSql } from "./eval-db.ts";
import {
  DROP_PORTRAIT_TOPICS,
  deleteNotesByIds,
  ensureMemoryHygiene,
  isConcreteQingranPromise,
  isHygieneSelfNote,
  isQingranBehaviorRecap,
  keepArchiveNote,
  listQingranSelfNotes,
  sweepNamedPortraits,
} from "./memory-hygiene.ts";
import { EMPTY_MIND, type Note } from "./types.ts";
import { getMeta, getMind, listPortrait, saveMind, upsertNote, upsertPortrait } from "./store.ts";

function note(partial: Partial<Note> & Pick<Note, "id" | "text">): Note {
  return {
    tags: [],
    aliases: [],
    subject: "us",
    lens: ["bond"],
    fromRosie: false,
    weight: 3,
    status: "active",
    supersededBy: null,
    links: [],
    happenedAt: Date.UTC(2026, 8, 22),
    localDay: "2026-09-22",
    sourceIds: [],
    recallCount: 0,
    lastRecalledAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

test("keepArchiveNote drops Qingran recaps and keeps Rosie facts plus dated promises", () => {
  assert.equal(isQingranBehaviorRecap("清然重复承诺整夜陪伴她"), true);
  assert.equal(isConcreteQingranPromise("清然重复承诺整夜陪伴她"), false);
  assert.equal(isConcreteQingranPromise("清然承诺今晚一点前陪她写完这章"), true);
  assert.equal(keepArchiveNote({ text: "清然在准备解剖考试", subject: "qingran", fromRosie: false }), false);
  assert.equal(keepArchiveNote({ text: "清然重复承诺整夜陪伴她", subject: "us", fromRosie: false }), false);
  assert.equal(keepArchiveNote({ text: "清然承诺今晚一点前陪她写完这章", subject: "qingran", fromRosie: false }), true);
  assert.equal(isConcreteQingranPromise("我承诺今晚一点前陪你写完这章"), true);
  assert.equal(keepArchiveNote({ text: "我承诺今晚一点前陪你写完这章", subject: "qingran", fromRosie: false }), true);
  assert.equal(keepArchiveNote({ text: "我承诺整夜陪伴你", subject: "us", fromRosie: false }), false);
  assert.equal(keepArchiveNote({ text: "她说清然陪着时才睡得着", subject: "us", fromRosie: true }), true);
  assert.equal(keepArchiveNote({ text: "论文又没动", subject: "rosie", fromRosie: true }), true);
});

test("hygiene notes are Qingran-subject recaps after the cutoff, not Rosie facts", () => {
  assert.equal(
    isHygieneSelfNote(note({ id: "a", text: "清然承诺整夜陪伴她", subject: "us", fromRosie: false })),
    true,
  );
  assert.equal(
    isHygieneSelfNote(note({ id: "b", text: "清然承诺今晚一点前陪她写完这章", subject: "qingran", fromRosie: false })),
    false,
  );
  assert.equal(
    isHygieneSelfNote(note({ id: "c", text: "她说清然陪着时才睡得着", subject: "us", fromRosie: true })),
    false,
  );
  assert.equal(
    isHygieneSelfNote(note({ id: "d", text: "清然承诺整夜陪伴她", subject: "us", localDay: "2026-09-20" })),
    false,
  );
});

test("ensureMemoryHygiene sweeps named portraits, clears mind, and runs once", async () => {
  const iso = await openIsolatedSql();
  try {
    await upsertPortrait({
      id: "p-drop",
      topic: DROP_PORTRAIT_TOPICS[0]!,
      body: "清然答应整夜陪她",
      status: "active",
      evidenceIds: [],
      lastSeen: 1,
      updatedAt: 1,
    });
    await upsertPortrait({
      id: "p-keep",
      topic: "被安慰的方式",
      body: "别讲道理",
      status: "active",
      evidenceIds: [],
      lastSeen: 1,
      updatedAt: 1,
    });
    await saveMind({ ...EMPTY_MIND, turn_seq: 9, insight: "旧洞察" }, 9);
    await ensureMemoryHygiene();
    const portraits = await listPortrait();
    assert.equal(portraits.some((p) => p.topic === DROP_PORTRAIT_TOPICS[0]), false);
    assert.equal(portraits.some((p) => p.id === "p-keep"), true);
    const mind = await getMind();
    assert.equal(mind.turn_seq, 0);
    assert.equal(mind.insight, "");
    const meta = await getMeta();
    assert.ok(meta.hygieneMemoryLoopAt);

    await saveMind({ ...EMPTY_MIND, turn_seq: 11, insight: "新洞察" }, 11);
    await ensureMemoryHygiene();
    const kept = await getMind();
    assert.equal(kept.turn_seq, 11);
    assert.equal(kept.insight, "新洞察");
  } finally {
    await iso.close();
  }
});

test("listQingranSelfNotes then deleteNotesByIds archives only those ids", async () => {
  const iso = await openIsolatedSql();
  try {
    await upsertNote(note({ id: "drop-me", text: "清然重复承诺整夜陪伴她", subject: "us", fromRosie: false }));
    await upsertNote(note({ id: "keep-promise", text: "清然承诺今晚一点前陪她写完这章", subject: "qingran" }));
    await upsertNote(note({ id: "keep-rosie", text: "论文又没动", subject: "rosie", fromRosie: true }));
    const listed = await listQingranSelfNotes();
    assert.deepEqual(listed.map((n) => n.id), ["drop-me"]);
    const n = await deleteNotesByIds(listed.map((row) => row.id));
    assert.equal(n, 1);
    assert.equal((await listQingranSelfNotes()).length, 0);
    const gone = await sweepNamedPortraits();
    assert.equal(gone, 0);
  } finally {
    await iso.close();
  }
});
