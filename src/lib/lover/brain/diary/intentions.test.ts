import assert from "node:assert/strict";
import { test } from "node:test";
import { openIsolatedSql } from "../eval-db.ts";
import { applyIntentionOps, matchOpenIntention } from "./intentions.ts";
import { listIntentions, openIntentions, upsertIntention } from "../store.ts";
import type { Intention } from "../types.ts";

test("ADD of similar open intention becomes TOUCH", () => {
  const open: Intention[] = [
    {
      id: "i1",
      text: "写论文",
      tag: "论文",
      statedAt: 1,
      targetDay: null,
      status: "open",
      startedAt: null,
      doneAt: null,
      lastEvidenceAt: 1,
      evidenceIds: [],
      updatedAt: 1,
    },
  ];
  const hit = matchOpenIntention(open, { op: "ADD", text: "写论文", tag: "论文" });
  assert.equal(hit?.id, "i1");
});

test("same-day dusk ops are idempotent", async () => {
  const iso = await openIsolatedSql();
  try {
    const ops = [
      { op: "ADD", id: "", text: "写论文", tag: "论文", target_day: "", evidence_ids: ["n1"] },
    ];
    const first = await applyIntentionOps("2026-09-14", ops, 1000);
    const second = await applyIntentionOps("2026-09-14", ops, 2000);
    const all = await listIntentions();
    const open = await openIntentions();
    assert.equal(first.applied, 1);
    assert.equal(second.skipped, 1);
    assert.equal(all.filter((i) => i.text === "写论文").length, 1);
    assert.equal(open.length, 1);
  } finally {
    await iso.close();
  }
});

test("START already-started only appends evidence", async () => {
  const iso = await openIsolatedSql();
  try {
    await upsertIntention({
      id: "keep",
      text: "早点睡",
      tag: "睡眠",
      statedAt: 1,
      targetDay: null,
      status: "started",
      startedAt: 1,
      doneAt: null,
      lastEvidenceAt: 1,
      evidenceIds: ["a"],
      updatedAt: 1,
    });
    await applyIntentionOps(
      "2026-09-15",
      [{ op: "START", id: "keep", text: "早点睡", tag: "睡眠", target_day: "", evidence_ids: ["b"] }],
      3,
    );
    const all = await listIntentions();
    const row = all.find((i) => i.id === "keep")!;
    assert.equal(row.status, "started");
    assert.ok(row.evidenceIds.includes("a"));
    assert.ok(row.evidenceIds.includes("b"));
  } finally {
    await iso.close();
  }
});
