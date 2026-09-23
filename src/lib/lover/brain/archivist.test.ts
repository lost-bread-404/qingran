import assert from "node:assert/strict";
import { test } from "node:test";
import { validateOps } from "./archive-ops.ts";
import { openIsolatedSql } from "./eval-db.ts";
import { listHistoryWindow, unarchivedOverflow, upsertMessage } from "./store.ts";
import type { Note, StoredMessage } from "./types.ts";

function msg(partial: Partial<StoredMessage> & Pick<StoredMessage, "id" | "role" | "text">): StoredMessage {
  return {
    createdAt: 1,
    kind: "say",
    archivedAt: null,
    sessionId: "s",
    localDay: "2026-09-15",
    ...partial,
  };
}

function note(partial: Partial<Note> & Pick<Note, "id" | "text">): Note {
  return {
    tags: [],
    aliases: [],
    subject: "rosie",
    lens: ["diary"],
    fromRosie: true,
    weight: 3,
    status: "active",
    supersededBy: null,
    links: [],
    happenedAt: 1,
    localDay: "2026-09-14",
    sourceIds: [],
    recallCount: 0,
    lastRecalledAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

test("all-assistant sources force from_rosie false", () => {
  const batch = [msg({ id: "a1", role: "assistant", text: "今晚一点前我陪你把这章写完" })];
  const out = validateOps(
    [
      {
        op: "ADD",
        text: "清然承诺今晚一点前陪她写完这章",
        subject: "qingran",
        lens: ["bond"],
        from_rosie: true,
        source_ids: ["a1"],
        weight: 4,
      },
    ],
    batch,
    [],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.note.fromRosie, false);
});

test("SUPERSEDE of unknown id falls back to ADD unless similar", () => {
  const batch = [msg({ id: "u1", role: "user", text: "我又没写" })];
  const out = validateOps(
    [
      {
        op: "SUPERSEDE",
        target_id: "missing",
        text: "她又没写论文",
        subject: "rosie",
        lens: ["diary"],
        from_rosie: true,
        source_ids: ["u1"],
      },
    ],
    batch,
    [],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.supersede, undefined);
});

test("similar ADD becomes SUPERSEDE", () => {
  const batch = [msg({ id: "u1", role: "user", text: "论文还是没动" })];
  const existing = note({ id: "old", text: "论文还是没动，她又拖了" });
  const out = validateOps(
    [
      {
        op: "ADD",
        text: "论文还是没动，她又拖了",
        subject: "rosie",
        lens: ["diary"],
        from_rosie: true,
        source_ids: ["u1"],
      },
    ],
    batch,
    [existing],
  );
  assert.equal(out[0]!.supersede, "old");
});

test("SUPERSEDE unions source_ids and keeps a link to the old note", () => {
  const batch = [msg({ id: "u2", role: "user", text: "论文还是没动", createdAt: 200, localDay: "2026-09-16" })];
  const existing = note({
    id: "old",
    text: "Rosie 晚上想写论文但一直开始不了，说打开电脑就想躺",
    sourceIds: ["u1"],
    localDay: "2026-09-14",
  });
  const out = validateOps(
    [
      {
        op: "ADD",
        text: "Rosie 晚上想写论文但一直开始不了，说打开电脑就想躺",
        subject: "rosie",
        lens: ["diary"],
        from_rosie: true,
        source_ids: ["u2"],
      },
    ],
    batch,
    [existing],
  );
  assert.equal(out[0]!.supersede, "old");
  assert.ok(out[0]!.note.sourceIds.includes("u1"));
  assert.ok(out[0]!.note.sourceIds.includes("u2"));
  assert.ok(out[0]!.note.links.includes("old"));
});

test("empty lens or source outside batch is dropped", () => {
  const batch = [msg({ id: "u1", role: "user", text: "hi" })];
  const out = validateOps(
    [
      { op: "ADD", text: "x", lens: [], from_rosie: true, source_ids: ["u1"] },
      { op: "ADD", text: "有来源才记", lens: ["diary"], from_rosie: true, source_ids: ["nope"] },
    ],
    batch,
    [],
  );
  assert.equal(out.length, 0);
});

test("weight and tags are clamped", () => {
  const batch = [msg({ id: "u1", role: "user", text: "口腔溃疡好痛" })];
  const out = validateOps(
    [
      {
        op: "ADD",
        text: "她口腔溃疡，很痛",
        tags: ["身体", "口腔溃疡", "too-long-tag-name", "a", "b", "c", "d"],
        subject: "rosie",
        lens: ["diary", "bond", "nope"],
        from_rosie: true,
        source_ids: ["u1"],
        weight: 99,
      },
    ],
    batch,
    [],
  );
  assert.equal(out[0]!.note.weight, 5);
  assert.ok(out[0]!.note.tags.length <= 6);
  assert.deepEqual(out[0]!.note.lens.sort(), ["bond", "diary"]);
});

test("aliases are clamped to 6 x 12 and stored on the note", () => {
  const batch = [msg({ id: "u1", role: "user", text: "Citadel superday 好紧张" })];
  const out = validateOps(
    [
      {
        op: "ADD",
        text: "她周五有 Citadel 面试",
        tags: ["面试"],
        aliases: ["citadel", "超级日", "superday", "too-long-alias-name", "a", "b", "c"],
        subject: "rosie",
        lens: ["diary"],
        from_rosie: true,
        source_ids: ["u1"],
      },
    ],
    batch,
    [],
  );
  assert.equal(out[0]!.note.aliases.length, 6);
  assert.ok(out[0]!.note.aliases.every((a) => a.length <= 12));
  assert.ok(out[0]!.note.aliases.includes("citadel"));
});

test("Qingran behavior recaps are dropped; concrete promises and Rosie facts are kept", () => {
  const batch = [
    msg({ id: "a1", role: "assistant", text: "今晚一点前我陪你把这章写完" }),
    msg({ id: "u1", role: "user", text: "你陪着我才睡得着" }),
    msg({ id: "a2", role: "assistant", text: "我答应整夜陪你" }),
  ];
  const out = validateOps(
    [
      {
        op: "ADD",
        text: "清然承诺今晚一点前陪她写完这章",
        subject: "qingran",
        lens: ["bond"],
        from_rosie: false,
        source_ids: ["a1"],
      },
      {
        op: "ADD",
        text: "清然重复承诺整夜陪伴她",
        subject: "us",
        lens: ["bond"],
        from_rosie: false,
        source_ids: ["a2"],
      },
      {
        op: "ADD",
        text: "清然在准备解剖考试",
        subject: "qingran",
        lens: ["bond"],
        from_rosie: true,
        source_ids: ["a1"],
      },
      {
        op: "ADD",
        text: "她说清然陪着时才睡得着",
        subject: "us",
        lens: ["bond"],
        from_rosie: true,
        source_ids: ["u1"],
      },
    ],
    batch,
    [],
  );
  assert.deepEqual(
    out.map((x) => x.note.text).sort(),
    ["她说清然陪着时才睡得着", "清然承诺今晚一点前陪她写完这章"].sort(),
  );
  const promise = out.find((x) => x.note.subject === "qingran");
  assert.equal(promise?.note.fromRosie, false);
});

test("unarchived overflow uses the same window as voice history, including zero", async () => {
  const iso = await openIsolatedSql();
  try {
    for (let i = 0; i < 5; i++) {
      await upsertMessage({
        id: `m${i}`,
        role: i % 2 ? "assistant" : "user",
        text: `t${i}`,
        createdAt: 1_000 + i,
        timeZone: "UTC",
      });
    }
    assert.deepEqual(
      (await unarchivedOverflow(20, 2)).map((m) => m.id),
      ["m0", "m1", "m2"],
    );
    assert.deepEqual(
      (await unarchivedOverflow(20, 0)).map((m) => m.id),
      ["m0", "m1", "m2", "m3", "m4"],
    );
    assert.deepEqual((await unarchivedOverflow(20, 5)).map((m) => m.id), []);
    assert.equal((await listHistoryWindow(null, 0)).length, 0);
    assert.equal((await listHistoryWindow("m4", 2)).map((m) => m.id).join(","), "m2,m3");
  } finally {
    await iso.close();
  }
});

test("history keeps the chosen reply and ignores the other pages", async () => {
  const iso = await openIsolatedSql();
  const t = 2_000;
  try {
    await upsertMessage({ id: "u1", role: "user", text: "⟦选:a1⟧在吗", createdAt: t, timeZone: "UTC" });
    await upsertMessage({
      id: "a1",
      role: "assistant",
      text: "⟦回:u1⟧第一句",
      createdAt: t + 1,
      timeZone: "UTC",
    });
    await upsertMessage({
      id: "a2",
      role: "assistant",
      text: "⟦回:u1⟧第二句",
      createdAt: t + 2,
      timeZone: "UTC",
    });
    assert.deepEqual(
      (await listHistoryWindow(null, 10)).map((m) => m.id),
      ["u1", "a1"],
    );
    assert.deepEqual((await listHistoryWindow("u1", 10)).map((m) => m.id), []);
  } finally {
    await iso.close();
  }
});
