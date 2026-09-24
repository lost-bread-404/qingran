import assert from "node:assert/strict";
import { test } from "node:test";
import { openIsolatedSql } from "../eval-db.ts";
import { listPortrait, upsertPortrait } from "../store.ts";
import type { PortraitRow } from "../types.ts";
import { lockedProfile } from "../../types.ts";
import {
  applyPortraitReview,
  formatOldPortrait,
  portraitRetireReason,
  RELATIONSHIP_TOPIC,
} from "./portrait-life.ts";

const DAY = 86_400_000;

function row(partial: Partial<PortraitRow> & Pick<PortraitRow, "id" | "topic">): PortraitRow {
  return {
    body: partial.topic,
    status: "active",
    kind: "trait",
    evidenceIds: [],
    lastSeen: 1,
    lastSupportedAt: 1,
    supportCount: 1,
    updatedAt: 1,
    ...partial,
  };
}

const days = new Map([
  ["n1", "2026-09-01"],
  ["n1b", "2026-09-01"],
  ["n2", "2026-09-03"],
  ["n3", "2026-09-10"],
]);

test("profile clamps portrait limits", () => {
  assert.equal(lockedProfile({}).portraitActiveMax, 12);
  assert.equal(lockedProfile({}).portraitStaleDays, 14);
  assert.equal(lockedProfile({ portraitActiveMax: 99 }).portraitActiveMax, 40);
  assert.equal(lockedProfile({ portraitActiveMax: 1 }).portraitActiveMax, 4);
  assert.equal(lockedProfile({ portraitStaleDays: 1 }).portraitStaleDays, 3);
  assert.equal(lockedProfile({ portraitStaleDays: 200 }).portraitStaleDays, 90);
  assert.equal(lockedProfile({}).retrieveMinTerms, 1);
  assert.equal(lockedProfile({ retrieveMinTerms: 0 }).retrieveMinTerms, 1);
  assert.equal(lockedProfile({ retrieveMinTerms: 9 }).retrieveMinTerms, 6);
});

test("new trait needs two dates; episodes, recaps, and one-offs are dropped", () => {
  const kept = applyPortraitReview({
    existing: [],
    ops: [{ topic: "不安", body: "你一被讲道理就缩", kind: "trait", evidence_ids: ["n1", "n2"], verdict: "new" }],
    evidenceDays: days,
    now: 100,
    activeMax: 12,
    staleDays: 14,
    allocateId: () => "p-new",
  });
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.id, "p-new");
  assert.equal(kept[0]!.status, "active");
  assert.equal(kept[0]!.supportCount, 1);
  assert.deepEqual(kept[0]!.evidenceIds, ["n1", "n2"]);

  const oneDay = applyPortraitReview({
    existing: [],
    ops: [{ topic: "不安", body: "你一被讲道理就缩", evidence_ids: ["n1", "n1b"], verdict: "new" }],
    evidenceDays: days,
    now: 100,
    activeMax: 12,
    staleDays: 14,
  });
  assert.equal(oneDay.length, 0);

  const episode = applyPortraitReview({
    existing: [],
    ops: [{ topic: "那晚的噩梦", body: "你那晚醒了", kind: "episode", evidence_ids: ["n1", "n2"], verdict: "new" }],
    evidenceDays: days,
    now: 100,
    activeMax: 12,
    staleDays: 14,
  });
  assert.equal(episode.length, 0);

  const recap = applyPortraitReview({
    existing: [],
    ops: [{ topic: "陪伴", body: "我承诺今晚陪你", evidence_ids: ["n1", "n2"], verdict: "new" }],
    evidenceDays: days,
    now: 100,
    activeMax: 12,
    staleDays: 14,
  });
  assert.equal(recap.length, 0);

  const named = applyPortraitReview({
    existing: [],
    ops: [{ topic: "整夜陪伴承诺", body: "你需要人在旁边才睡得着", evidence_ids: ["n1", "n2"], verdict: "new" }],
    evidenceDays: days,
    now: 100,
    activeMax: 12,
    staleDays: 14,
  });
  assert.equal(named.length, 0);
});

test("support refreshes only when evidence still spans two dates", () => {
  const bumped = applyPortraitReview({
    existing: [row({ id: "p1", topic: "不安", body: "旧", evidenceIds: ["n1"], supportCount: 2, lastSupportedAt: 50 })],
    ops: [{ id: "p1", topic: "不安", body: "你一被讲道理就缩", evidence_ids: ["n2"], verdict: "support" }],
    evidenceDays: days,
    now: 100,
    activeMax: 12,
    staleDays: 14,
  });
  assert.equal(bumped[0]!.supportCount, 3);
  assert.equal(bumped[0]!.lastSupportedAt, 100);
  assert.equal(bumped[0]!.body, "你一被讲道理就缩");
  assert.equal(bumped[0]!.status, "active");

  const ignored = applyPortraitReview({
    existing: [row({ id: "p1", topic: "不安", evidenceIds: ["n1"], supportCount: 2, lastSupportedAt: 50 })],
    ops: [{ id: "p1", body: "还是这样", evidence_ids: ["n1b"], verdict: "support" }],
    evidenceDays: days,
    now: 100,
    activeMax: 12,
    staleDays: 14,
  });
  assert.equal(ignored[0]!.supportCount, 2);
  assert.equal(ignored[0]!.lastSupportedAt, 50);
  assert.equal(ignored[0]!.body, "不安");
});

test("supersede, age, and the active cap leave relationship outside the limit", () => {
  const now = 30 * DAY;
  const next = applyPortraitReview({
    existing: [
      row({ id: "keep", topic: "不安", supportCount: 5, lastSupportedAt: now - DAY }),
      row({ id: "mid", topic: "恢复", supportCount: 4, lastSupportedAt: now - DAY }),
      row({ id: "third", topic: "启动", supportCount: 3, lastSupportedAt: now - DAY }),
      row({ id: "fourth", topic: "睡眠", supportCount: 2, lastSupportedAt: now - DAY }),
      row({ id: "weak", topic: "胃口", supportCount: 1, lastSupportedAt: now - 2 * DAY }),
      row({ id: "old", topic: "旧习惯", supportCount: 9, lastSupportedAt: now - 15 * DAY }),
      row({ id: "edge", topic: "刚好十四天", supportCount: 8, lastSupportedAt: now - 14 * DAY }),
      row({ id: "gone", topic: "不再成立", supportCount: 3, lastSupportedAt: now }),
      row({ id: "rel", topic: RELATIONSHIP_TOPIC, body: "旧的靠近", supportCount: 4, lastSupportedAt: 10 }),
    ],
    ops: [{ id: "gone", topic: "不再成立", verdict: "supersede" }],
    relationship: { body: "比之前更敢靠过来", evidence_ids: ["n3"] },
    evidenceDays: days,
    now,
    activeMax: 4,
    staleDays: 14,
  });
  const byId = new Map(next.map((item) => [item.id, item]));
  assert.equal(byId.get("gone")!.status, "superseded");
  assert.equal(byId.get("old")!.status, "stale");
  assert.equal(byId.get("edge")!.status, "active");
  assert.equal(byId.get("keep")!.status, "active");
  assert.equal(byId.get("weak")!.status, "stale");
  const rel = byId.get("rel")!;
  assert.equal(rel.status, "active");
  assert.equal(rel.body, "比之前更敢靠过来");
  assert.equal(rel.supportCount, 5);
  assert.equal(rel.lastSupportedAt, now);
  assert.equal(next.filter((item) => item.status === "active" && item.topic !== RELATIONSHIP_TOPIC).length, 4);
});

test("a similar topic merges, a weaker row is displaced, and an empty relationship does not refresh", () => {
  const now = 100;
  const merged = applyPortraitReview({
    existing: [
      row({ id: "old", topic: "讲道理会让你缩回去", supportCount: 1, lastSupportedAt: 10, evidenceIds: ["n1"] }),
      row({ id: "rel", topic: RELATIONSHIP_TOPIC, body: "还是原来的距离", supportCount: 4, lastSupportedAt: 10 }),
    ],
    ops: [{ topic: "讲道理会让你缩", body: "你听到道理会先缩，过一会儿才肯说", evidence_ids: ["n2", "n3"], verdict: "new" }],
    relationship: { body: "   ", evidence_ids: [] },
    evidenceDays: days,
    now,
    activeMax: 12,
    staleDays: 14,
  });
  const trait = merged.find((item) => item.id === "old")!;
  assert.equal(trait.status, "active");
  assert.equal(trait.supportCount, 2);
  assert.equal(trait.body, "你听到道理会先缩，过一会儿才肯说");
  const rel = merged.find((item) => item.topic === RELATIONSHIP_TOPIC)!;
  assert.equal(rel.supportCount, 4);
  assert.equal(rel.body, "还是原来的距离");

  const displaced = applyPortraitReview({
    existing: [
      row({ id: "a", topic: "不安时会先缩回去", supportCount: 2, lastSupportedAt: 40 }),
      row({ id: "b", topic: "恢复靠被抱着", supportCount: 2, lastSupportedAt: 30 }),
      row({ id: "c", topic: "嘴上说没事", supportCount: 2, lastSupportedAt: 20 }),
      row({ id: "d", topic: "最弱的那条理解", supportCount: 1, lastSupportedAt: 10 }),
    ],
    ops: [{ topic: "讲道理会让你关门", body: "你听到道理会先不说话", evidence_ids: ["n1", "n2"], verdict: "new" }],
    evidenceDays: days,
    now,
    activeMax: 4,
    staleDays: 14,
    allocateId: () => "p-new",
  });
  assert.equal(displaced.find((item) => item.id === "p-new")!.status, "active");
  assert.equal(displaced.find((item) => item.id === "d")!.status, "stale");
  assert.equal(displaced.filter((item) => item.status === "active").length, 4);
});

test("stale can be corroborated again; superseded stays out of the prompt text", () => {
  const revived = applyPortraitReview({
    existing: [row({ id: "p1", topic: "不安", status: "stale", evidenceIds: ["n1"], supportCount: 2 })],
    ops: [{ id: "p1", evidence_ids: ["n2"], verdict: "support", body: "你需要先被接住" }],
    evidenceDays: days,
    now: 80,
    activeMax: 12,
    staleDays: 14,
  });
  assert.equal(revived[0]!.status, "active");
  assert.equal(revived[0]!.supportCount, 3);

  const text = formatOldPortrait(
    [
      row({ id: "live", topic: "不安", body: "还在" }),
      row({ id: "dead", topic: "旧", status: "superseded", body: "不要注入" }),
    ],
    "UTC",
  );
  assert.match(text, /live\|/);
  assert.doesNotMatch(text, /不要注入/);
});

test("retire reasons flag events and thin evidence, not the relationship row", () => {
  assert.equal(portraitRetireReason(row({ id: "a", topic: "整夜陪伴承诺" }), days), "具体事件");
  assert.equal(portraitRetireReason(row({ id: "b", topic: "那晚", kind: "episode", evidenceIds: ["n1", "n2"] }), days), "具体事件");
  assert.equal(portraitRetireReason(row({ id: "c", topic: "称呼", evidenceIds: [] }), days), null);
  assert.equal(portraitRetireReason(row({ id: "c2", topic: "被抱着才会松", evidenceIds: [] }), days), "依据不足 2 个不同日期");
  assert.equal(
    portraitRetireReason(row({ id: "d", topic: "靠近", body: "这一次你靠过来了", evidenceIds: ["n1", "n2"] }), days),
    "具体事件",
  );
  assert.equal(portraitRetireReason(row({ id: "e", topic: RELATIONSHIP_TOPIC, evidenceIds: [] }), days), null);
  assert.equal(
    portraitRetireReason(row({ id: "f", topic: "不安", body: "你需要先被接住", evidenceIds: ["n1", "n2"] }), days),
    null,
  );
});

test("portrait columns round-trip and dormant rows read as stale", async () => {
  const iso = await openIsolatedSql();
  try {
    await upsertPortrait({
      id: "p1",
      topic: "不安",
      body: "你一被讲道理就缩",
      status: "active",
      kind: "trait",
      evidenceIds: ["a", "b"],
      lastSeen: 10,
      lastSupportedAt: 9,
      supportCount: 3,
      updatedAt: 10,
    });
    await iso.sql.query(
      `insert into qr_portrait (id, topic, body, status, evidence_ids, last_seen, updated_at)
       values ('old', '旧习惯', '正文', 'dormant', '{}', 4, 8)`,
    );
    const rows = await listPortrait();
    const saved = rows.find((item) => item.id === "p1")!;
    assert.equal(saved.kind, "trait");
    assert.equal(saved.supportCount, 3);
    assert.equal(saved.lastSupportedAt, 9);
    assert.deepEqual(saved.evidenceIds, ["a", "b"]);
    const legacy = rows.find((item) => item.id === "old")!;
    assert.equal(legacy.status, "stale");
    assert.equal(legacy.kind, "trait");
    assert.equal(legacy.lastSupportedAt, 8);
    assert.equal(legacy.supportCount, 1);
  } finally {
    await iso.close();
  }
});

test("story seeds stay active, out of the cap, and out of review", () => {
  const now = 30 * DAY;
  const next = applyPortraitReview({
    existing: [
      row({ id: "p:names", topic: "称呼", body: "叫姐姐", kind: "seed", lastSupportedAt: 1 }),
      row({ id: "old-trait", topic: "不安时会先缩回去", supportCount: 1, lastSupportedAt: now - 20 * DAY }),
    ],
    ops: [
      { id: "p:names", topic: "称呼", body: "改掉设定", verdict: "supersede" },
      { topic: "称呼", body: "另一条称呼", evidence_ids: ["n1", "n2"], verdict: "new" },
    ],
    evidenceDays: days,
    now,
    activeMax: 4,
    staleDays: 14,
  });
  const seed = next.find((item) => item.id === "p:names")!;
  assert.equal(seed.kind, "seed");
  assert.equal(seed.status, "active");
  assert.equal(seed.body, "叫姐姐");
  assert.equal(next.some((item) => item.topic === "称呼" && item.id !== "p:names"), false);
  assert.equal(next.find((item) => item.id === "old-trait")!.status, "stale");
  assert.equal(formatOldPortrait(next, "UTC").includes("称呼"), false);
});

test("migration marks story seeds and stales confirmed events, not thin traits", async () => {
  const iso = await openIsolatedSql();
  try {
    await iso.sql.query(
      `insert into qr_portrait (id, topic, body, status, kind, evidence_ids, last_seen, last_supported_at, support_count, updated_at)
       values
         ('p:names', '称呼', '姐姐', 'active', 'trait', '{}', 1, 1, 1, 1),
         ('ev', '整夜陪伴承诺', '陪一夜', 'active', 'trait', '{}', 1, 1, 1, 1),
         ('night', '习惯', '她今晚哭了很久', 'active', 'trait', '{}', 1, 1, 1, 1),
         ('thin', '被抱着才会松', '你不安的时候要被抱着', 'active', 'trait', '{}', 1, 1, 1, 1)`,
    );
    const sql = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../../../../migrations/0026_portrait_seed.sql", import.meta.url), "utf8"),
    );
    for (const stmt of sql.split(";").map((part) => part.trim()).filter(Boolean)) {
      await iso.sql.query(stmt);
    }
    const rows = await listPortrait();
    const byId = new Map(rows.map((item) => [item.id, item]));
    assert.equal(byId.get("p:names")!.kind, "seed");
    assert.equal(byId.get("p:names")!.status, "active");
    assert.equal(byId.get("ev")!.status, "stale");
    assert.equal(byId.get("night")!.status, "stale");
    assert.equal(byId.get("thin")!.status, "active");
    assert.equal(byId.get("thin")!.kind, "trait");
  } finally {
    await iso.close();
  }
});
