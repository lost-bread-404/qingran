import assert from "node:assert/strict";
import { test } from "node:test";
import { setClock } from "../clock.ts";
import { LONG_DRAIN_MS } from "../config.ts";
import { openIsolatedSql } from "../eval-db.ts";
import { enqueuePeriodicIfDue, runDusk } from "./dusk.ts";
import { drainJobs, enqueue } from "../jobs.ts";
import * as S from "../store.ts";

const TZ = "America/New_York";
const at = (d: string, hm: string) => new Date(`${d}T${hm}:00-04:00`).getTime();

function installMock() {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (!u.startsWith("https://api.x.ai/")) return real(url, init);
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      text?: { format?: { name?: string } };
    };
    const name = body.text?.format?.name ?? "chat";
    calls.push(name);
    return new Response(JSON.stringify({ output_text: "{}" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = real;
    },
  };
}

test("empty library plus one today-message only spends reflect", async () => {
  process.env.XAI_API_KEY = "mock";
  const iso = await openIsolatedSql();
  const mock = installMock();
  const nowMs = at("2026-09-16", "19:00");
  setClock(() => nowMs);
  try {
    await S.upsertMessage({
      id: "u:1",
      role: "user",
      text: "嗨",
      createdAt: nowMs,
      timeZone: TZ,
    });
    await enqueue("reflect", `reflect:${nowMs}`, { turnSeq: nowMs });
    await enqueuePeriodicIfDue(nowMs, TZ);
    await drainJobs(LONG_DRAIN_MS);
    const jobs = await (await S.sql()).query<{ type: string; status: string; dedupe_key: string }>(
      "select type, status, dedupe_key from brain_jobs order by created_at",
    );
    const duskJobs = jobs.filter((j) => j.type === "dusk");
    assert.equal(duskJobs.length, 0, JSON.stringify(duskJobs));
    assert.ok(mock.calls.every((n) => n === "mind" || n === "chat"), mock.calls.join(","));
  } finally {
    mock.restore();
    setClock(null);
    await iso.close();
  }
});

test("empty day dusk writes coverage none without calling models", async () => {
  process.env.XAI_API_KEY = "mock";
  const iso = await openIsolatedSql();
  const mock = installMock();
  setClock(() => at("2026-09-16", "06:00"));
  try {
    await runDusk("2026-09-10");
    const day = await S.getDay("2026-09-10");
    assert.equal(day?.coverage, "none");
    assert.equal(day?.msgCount, 0);
    const factors = await S.listDayFactors("2026-09-10", "2026-09-10");
    assert.ok(factors.length > 0);
    assert.ok(factors.every((f) => f.value == null));
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
    setClock(null);
    await iso.close();
  }
});

test("notesForDay keeps superseded notes on their original day", async () => {
  const iso = await openIsolatedSql();
  try {
    const ts = at("2026-09-14", "23:10");
    await (await S.sql()).query(
      `insert into mem_notes (
         id, text, tags, subject, lens, from_rosie, weight, status, superseded_by, links,
         happened_at, local_day, source_ids, created_at, updated_at
       ) values
       ('old','Rosie 晚上想写论文但一直开始不了，说打开电脑就想躺','{论文}','rosie','{diary}',true,4,'superseded','new','{}',$1,'2026-09-14','{u:1}',$1,$1),
       ('new','Rosie 晚上想写论文但一直开始不了，说打开电脑就想躺','{论文}','rosie','{diary}',true,4,'active',null,'{old}',$2,'2026-09-16','{u:1,u:2}',$2,$2)`,
      [ts, ts + 2 * 86_400_000],
    );
    const oldDay = await S.notesForDay("2026-09-14", true);
    assert.ok(oldDay.some((n) => n.id === "old" && n.status === "superseded"));
    const newDay = await S.notesForDay("2026-09-16", true);
    assert.ok(newDay.some((n) => n.id === "new"));
  } finally {
    await iso.close();
  }
});
