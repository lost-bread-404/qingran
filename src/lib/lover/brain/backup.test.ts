import assert from "node:assert/strict";
import { test } from "node:test";
import { convertV1, exportBackupPage, importTableChunk, IMPORT_ORDER, type BackupRow, type ExportPage } from "./backup.ts";
import { openIsolatedSql } from "./eval-db.ts";
import { getSql } from "../../db.ts";
import { SESSION_GAP_MS } from "./config.ts";

async function exportAll(maxBytes = 750_000): Promise<ExportPage[]> {
  const pages: ExportPage[] = [];
  let cursor: ExportPage["next"] = null;
  for (let i = 0; i < 200; i++) {
    const page = await exportBackupPage({ cursor, maxBytes });
    pages.push(page);
    if (page.done || !page.next) break;
    cursor = page.next;
  }
  return pages;
}

async function importPages(pages: ExportPage[]) {
  const byTable = new Map<string, BackupRow[]>();
  for (const page of pages) {
    if (!page.table || !page.rows.length) continue;
    const list = byTable.get(page.table) ?? [];
    list.push(...page.rows);
    byTable.set(page.table, list);
  }
  const totals = { inserted: 0, updated: 0, skipped: 0 };
  for (const table of IMPORT_ORDER) {
    const rows = byTable.get(table) ?? [];
    if (!rows.length) continue;
    const r = await importTableChunk(table, rows);
    totals.inserted += r.inserted;
    totals.updated += r.updated;
    totals.skipped += r.skipped;
  }
  return { byTable, totals, profile: pages.find((p) => p.profile)?.profile };
}

test("v1 conversion fills local_day, session_id, and legacy notes", () => {
  const t0 = 1_700_000_000_000;
  const converted = convertV1(
    {
      kind: "qingran-backup",
      version: 1,
      profile: { systemPrompt: "你就是清然。", muted: false, softVoice: false, autoRemember: true, memoryCursor: "" },
      messages: [
        { id: "m1", role: "user", text: "嗨", createdAt: t0 },
        { id: "m2", role: "assistant", text: "在", createdAt: t0 + 1000 },
        { id: "m3", role: "user", text: "隔了很久", createdAt: t0 + SESSION_GAP_MS + 5000 },
      ],
      memories: [{ id: "mem1", text: "她怕冷", createdAt: t0, updatedAt: t0 }],
    },
    "UTC",
  );
  assert.equal(converted.tables.qingran_messages.length, 3);
  assert.equal(converted.tables.qingran_messages[0]!.archived_at, null);
  assert.ok(converted.tables.qingran_messages[0]!.local_day);
  assert.equal(
    converted.tables.qingran_messages[0]!.session_id,
    converted.tables.qingran_messages[1]!.session_id,
  );
  assert.notEqual(
    converted.tables.qingran_messages[0]!.session_id,
    converted.tables.qingran_messages[2]!.session_id,
  );
  assert.equal(converted.tables.mem_notes.length, 1);
  assert.equal(converted.tables.mem_notes[0]!.id, "legacy:mem1");
  assert.equal(converted.tables.mem_notes[0]!.subject, "us");
  assert.deepEqual(converted.tables.mem_notes[0]!.lens, ["bond", "diary"]);
  assert.equal(converted.tables.mem_notes[0]!.from_rosie, true);
  assert.equal(converted.tables.mem_notes[0]!.weight, 4);
});

test("v1 conversion uses the given timeZone for local_day", () => {
  // 2026-01-15 03:30 UTC = 2026-01-14 22:30 New York (EST)
  const at = Date.UTC(2026, 0, 15, 3, 30, 0);
  const converted = convertV1(
    {
      kind: "qingran-backup",
      version: 1,
      messages: [{ id: "m1", role: "user", text: "晚了", createdAt: at }],
      memories: [],
    },
    "America/New_York",
  );
  assert.equal(converted.tables.qingran_messages[0]!.local_day, "2026-01-14");
});

test("v2 roundtrip, idempotent re-import, skipped illegal rows, chunk split", async () => {
  const a = await openIsolatedSql();
  try {
    const db = await getSql();
    await db.query(
      `insert into qingran_messages (id, role, body, created_at, kind, session_id, local_day)
       values ('m1','user','今天好累',1000,'say','s:1000','2026-09-01'),
              ('m2','assistant','先睡',1001,'say','s:1000','2026-09-01')`,
    );
    await db.query(
      `insert into mem_notes (
         id, text, tags, subject, lens, from_rosie, weight, status, links,
         happened_at, local_day, source_ids, created_at, updated_at
       ) values (
         'n1','她好累','{}','rosie','{diary}',true,4,'active','{}',
         1000,'2026-09-01','{}',1000,1000
       )`,
    );
    const pages = await exportAll(80);
    assert.ok(pages.length >= 2, "small maxBytes should split pages");
    const exportedNotes = pages.flatMap((p) => (p.table === "mem_notes" ? p.rows : []));
    const exportedMsgs = pages.flatMap((p) => (p.table === "qingran_messages" ? p.rows : []));
    assert.ok(exportedNotes.some((r) => r.id === "n1"));
    assert.equal(exportedMsgs.length, 2);

    await a.close();
    const b = await openIsolatedSql();
    try {
      const first = await importPages(pages);
      assert.equal(first.totals.skipped, 0);
      const notes = await (await getSql()).query<{ id: string; text: string }>(
        "select id, text from mem_notes where id = 'n1'",
      );
      assert.equal(notes[0]?.text, "她好累");
      const msgs = await (await getSql()).query<{ n: number }>(
        "select count(*)::int as n from qingran_messages",
      );
      assert.equal(msgs[0]?.n, 2);

      const second = await importPages(pages);
      assert.ok(second.totals.updated >= 2);
      assert.equal(second.totals.inserted, 0);

      const bad = await importTableChunk("qingran_messages", [
        { role: "user", body: "no id" },
        { id: "m3", role: "user", body: "ok", created_at: 3, kind: "say" },
      ]);
      assert.equal(bad.skipped, 1);
      assert.equal(bad.inserted, 1);
    } finally {
      await b.close();
    }
  } finally {
    try {
      await a.close();
    } catch {
      /* already closed */
    }
  }
});
