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
import { EMPTY_INNER, type Note } from "./types.ts";
import { getInner, getMeta, listPortrait, saveInner, upsertNote, upsertPortrait } from "./store.ts";

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

test("ensureMemoryHygiene clears mind once and does not delete portraits", async () => {
  const iso = await openIsolatedSql();
  try {
    await upsertPortrait({
      id: "p-drop",
      topic: DROP_PORTRAIT_TOPICS[0]!,
      body: "清然答应整夜陪她",
      status: "active",
      kind: "trait",
      evidenceIds: [],
      lastSeen: 1,
      lastSupportedAt: 1,
      supportCount: 1,
      updatedAt: 1,
    });
    await upsertPortrait({
      id: "p-keep",
      topic: "被安慰的方式",
      body: "别讲道理",
      status: "active",
      kind: "trait",
      evidenceIds: [],
      lastSeen: 1,
      lastSupportedAt: 1,
      supportCount: 1,
      updatedAt: 1,
    });
    await saveInner(
      {
        ...EMPTY_INNER,
        feel: "旧心思",
        longing: "还惦记着",
        plans: [{ id: "p1", what: "以后问", trigger: "她提起", expires_at: 9, status: "open" }],
        turn_seq: 9,
        updated_at: 9,
        longing_updated_at: 4,
      },
      9,
    );
    await ensureMemoryHygiene();
    const portraits = await listPortrait();
    assert.equal(portraits.some((p) => p.topic === DROP_PORTRAIT_TOPICS[0]), true);
    assert.equal(portraits.some((p) => p.id === "p-keep"), true);
    const inner = await getInner();
    assert.equal(inner.turn_seq, 0);
    assert.equal(inner.feel, "");
    assert.equal(inner.longing, "还惦记着");
    assert.equal(inner.plans[0]?.id, "p1");
    const meta = await getMeta();
    assert.ok(meta.hygieneMemoryLoopAt);

    await saveInner({ ...inner, feel: "新心思", turn_seq: 11, updated_at: 11 }, 11);
    await ensureMemoryHygiene();
    const kept = await getInner();
    assert.equal(kept.turn_seq, 11);
    assert.equal(kept.feel, "新心思");
    assert.equal(kept.longing, "还惦记着");
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
