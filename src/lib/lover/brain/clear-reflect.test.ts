import assert from "node:assert/strict";
import { test } from "node:test";
import { setClock } from "./clock.ts";
import { openIsolatedSql } from "./eval-db.ts";
import { enqueue } from "./jobs.ts";
import {
  claimJob,
  clearRecentConversation,
  finishReflectJob,
  getInner,
  listHistoryWindow,
  listRecentMessages,
  markArchived,
  saveInner,
  sql,
  upsertMessage,
  upsertNote,
  upsertReflectJob,
} from "./store.ts";
import { EMPTY_INNER, type InnerPlan, type Note } from "./types.ts";

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
    localDay: "2026-09-20",
    sourceIds: [],
    recallCount: 0,
    lastRecalledAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

test("clear keeps archived notes and only forgets unarchived turns", async () => {
  const iso = await openIsolatedSql();
  const t0 = Date.UTC(2026, 8, 20, 16, 0, 0);
  const t1 = t0 + 1_000;
  const tClear = t0 + 3_000;
  try {
    setClock(() => t0);
    await upsertMessage({ id: "old-u", role: "user", text: "昨天", createdAt: t0, timeZone: TZ });
    await upsertMessage({ id: "old-a", role: "assistant", text: "嗯", createdAt: t0 + 1, timeZone: TZ });
    await markArchived(["old-u", "old-a"], t0 + 2);
    await upsertNote(note({ id: "n-keep", text: "已经记住的事", sourceIds: ["old-u"], createdAt: t0 }));

    setClock(() => t1);
    await upsertMessage({ id: "new-u", role: "user", text: "刚说的", createdAt: t1, timeZone: TZ });
    await upsertMessage({ id: "new-a", role: "assistant", text: "还没归档", createdAt: t1 + 1, timeZone: TZ });
    const keptPlan: InnerPlan = {
      id: "p1",
      what: "明天早上问她睡得怎么样",
      why: "",
      trigger: "她醒来",
      expires_at: tClear + 86_400_000,
      status: "open",
    };
    await saveInner(
      {
        ...EMPTY_INNER,
        feel: "刚说的",
        want: "想抱",
        choice: "先听",
        now: "听她说",
        longing: "一直惦记",
        plans: [keptPlan],
        turn_seq: t1,
        updated_at: t1,
        longing_updated_at: t0,
      },
      t1,
    );

    setClock(() => tClear);
    await clearRecentConversation();

    const screen = await listRecentMessages(240);
    assert.equal(screen.length, 0);
    const history = await listHistoryWindow(null, 40);
    assert.equal(history.length, 0);
    const inner = await getInner();
    assert.equal(inner.turn_seq, 0);
    assert.equal(inner.feel, "");
    assert.equal(inner.want, "");
    assert.equal(inner.choice, "");
    assert.equal(inner.now, "");
    assert.equal(inner.longing, "一直惦记");
    assert.equal(inner.plans[0]?.id, "p1");
    assert.equal(inner.plans[0]?.status, "open");

    const rows = await (await sql()).query<{ id: string; forgotten_at: number | null; archived_at: number | null }>(
      `select id, forgotten_at, archived_at from qingran_messages order by id`,
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(byId["old-u"]!.archived_at != null, true);
    assert.equal(byId["old-u"]!.forgotten_at, null);
    assert.equal(byId["old-a"]!.forgotten_at, null);
    assert.ok(byId["new-u"]!.forgotten_at);
    assert.ok(byId["new-a"]!.forgotten_at);
    assert.equal(byId["new-u"]!.archived_at, null);

    const kept = await (await sql()).query<{ status: string }>(`select status from mem_notes where id = 'n-keep'`);
    assert.equal(kept[0]!.status, "active");

    setClock(() => tClear + 1);
    await upsertMessage({ id: "after-u", role: "user", text: "清空后", createdAt: tClear + 1, timeZone: TZ });
    const after = await listRecentMessages(240);
    assert.deepEqual(after.map((m) => m.id), ["after-u"]);
  } finally {
    setClock(null);
    await iso.close();
  }
});

test("one Reflector slot coalesces to the latest turn and reruns once", async () => {
  const iso = await openIsolatedSql();
  const t1 = Date.UTC(2026, 8, 21, 13, 0, 0);
  try {
    setClock(() => t1);
    await enqueue("reflect", "reflect:ignore", { turnSeq: t1 });
    const jobs = await (await sql()).query<{ id: string; n: number }>(
      `select id, count(*) over ()::int as n from brain_jobs where type = 'reflect'`,
    );
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.n, 1);
    const id = jobs[0]!.id;
    const claimed = await claimJob(t1, 240_000, id);
    assert.ok(claimed);
    assert.equal(claimed!.status, "running");

    await upsertReflectJob(t1 + 1);
    await upsertReflectJob(t1 + 2);
    const still = await (await sql()).query<{ status: string; seq: string; attempts: number }>(
      `select status, payload->>'turnSeq' as seq, attempts from brain_jobs where id = $1`,
      [id],
    );
    assert.equal(still.length, 1);
    assert.equal(still[0]!.status, "running");
    assert.equal(Number(still[0]!.seq), t1 + 2);

    const follow = await finishReflectJob(id, t1);
    assert.equal(follow, "pending");
    const reopened = await (await sql()).query<{ status: string; attempts: number; seq: string }>(
      `select status, attempts, payload->>'turnSeq' as seq from brain_jobs where id = $1`,
      [id],
    );
    assert.equal(reopened[0]!.status, "pending");
    assert.equal(reopened[0]!.attempts, 0);
    assert.equal(Number(reopened[0]!.seq), t1 + 2);

    const done = await finishReflectJob(id, t1 + 2);
    assert.equal(done, "done");
  } finally {
    setClock(null);
    await iso.close();
  }
});
