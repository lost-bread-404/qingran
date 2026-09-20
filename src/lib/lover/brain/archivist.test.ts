import assert from "node:assert/strict";
import { test } from "node:test";
import { validateOps } from "./archive-ops.ts";
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
  const batch = [msg({ id: "a1", role: "assistant", text: "我在准备解剖考试" })];
  const out = validateOps(
    [
      {
        op: "ADD",
        text: "清然在准备解剖考试",
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
