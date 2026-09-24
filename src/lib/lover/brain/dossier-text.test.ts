import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyDossierOps,
  batchConversation,
  DEFAULT_DOSSIER,
  editorDue,
} from "./dossier-text.ts";

test("add creates a missing section and appends", () => {
  const next = applyDossierOps(DEFAULT_DOSSIER, [
    { section: "## 我自己", action: "add", old: "", new: "我想把这一年过完。" },
  ]);
  assert.match(next.body, /## 我自己\n我想把这一年过完。/);
  assert.equal(next.skipped.length, 0);
});

test("replace requires the old text and remove drops it", () => {
  const start = applyDossierOps(DEFAULT_DOSSIER, [
    { section: "## 我们", action: "add", old: "", new: "你叫我姐姐。" },
  ]).body;
  const replaced = applyDossierOps(start, [
    { section: "## 我们", action: "replace", old: "你叫我姐姐。", new: "你叫我姐姐，我叫你小猫。" },
    { section: "## 我们", action: "replace", old: "不存在的句子", new: "跳过" },
  ]);
  assert.match(replaced.body, /你叫我姐姐，我叫你小猫。/);
  assert.equal(replaced.skipped[0]?.reason, "old not found");
  const removed = applyDossierOps(replaced.body, [
    { section: "## 我们", action: "remove", old: "你叫我姐姐，我叫你小猫。", new: "" },
  ]);
  assert.doesNotMatch(removed.body, /小猫/);
});

test("editor stays quiet until the dossier is on, then fires on turns or a gap with unread", () => {
  assert.equal(editorDue({ active: false, turns: 40, gap: true, unread: true }), null);
  assert.equal(editorDue({ active: true, turns: 19, gap: false, unread: true }), null);
  assert.equal(editorDue({ active: true, turns: 20, gap: false, unread: true }), "turns");
  assert.equal(editorDue({ active: true, turns: 1, gap: true, unread: false }), null);
  assert.equal(editorDue({ active: true, turns: 1, gap: true, unread: true }), "gap");
  assert.equal(editorDue({ active: false, turns: 0, gap: false, unread: false, manual: true }), "manual");
});

test("conversation batches stay inside the character cap and keep order", () => {
  const items = [
    { line: "a".repeat(8_000), createdAt: 1 },
    { line: "b".repeat(8_000), createdAt: 2 },
    { line: "c", createdAt: 3 },
  ];
  const batches = batchConversation(items, 12_000);
  assert.equal(batches.length, 2);
  assert.equal(batches[0]![0]!.createdAt, 1);
  assert.equal(batches[1]!.map((item) => item.createdAt).join(","), "2,3");
});
