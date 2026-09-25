import assert from "node:assert/strict";
import { test } from "node:test";
import { setClock } from "./clock.ts";
import { enableDossier, enqueueDossierActivate, ensureDossierLive, getDossier, listDossierVersions, runEditor, saveDossierBody, seedDossierDraft } from "./dossier.ts";
import { openIsolatedSql } from "./eval-db.ts";
import type { callModel } from "./llm.ts";
import { clearRecentConversation, upsertMessage } from "./store.ts";

const TZ = "America/New_York";

function fake(json: unknown): typeof callModel {
  return (async () => ({
    ok: true,
    text: JSON.stringify(json),
    json,
    toolCalls: [],
    raw: {},
    model: "test",
    effort: "medium" as const,
    ms: 3,
  })) as typeof callModel;
}

test("enable switches the live body and parks the cursor on the latest message", async () => {
  const iso = await openIsolatedSql();
  const t0 = Date.UTC(2026, 8, 20, 12, 0, 0);
  try {
    setClock(() => t0);
    await upsertMessage({ id: "u1", role: "user", text: "在吗", createdAt: t0, timeZone: TZ });
    const before = await getDossier();
    assert.equal(before.active, false);
    const on = await enableDossier("## 我们\n你在。\n");
    assert.equal(on.active, true);
    assert.equal(on.cursorAt, t0);
    assert.match(on.body, /你在/);
    const versions = await listDossierVersions();
    assert.equal(versions[0]?.author, "rosie");
  } finally {
    setClock(null);
    await iso.close();
  }
});

test("editor applies ops, advances the cursor, and compacts when the body is too long", async () => {
  const iso = await openIsolatedSql();
  const t0 = Date.UTC(2026, 8, 21, 12, 0, 0);
  try {
    setClock(() => t0);
    await enableDossier("## 我自己\n短。\n");
    await (await import("./store.ts")).sql().then((db) =>
      db.query("update qr_dossier set cursor_at = $1 where id = 1", [t0 - 10]),
    );
    await upsertMessage({ id: "u2", role: "user", text: "今天很累", createdAt: t0, timeZone: TZ });
    let calls = 0;
    const complete: typeof callModel = (async (_route, input) => {
      calls += 1;
      if (String(input.system).includes("压到") || String(input.input).includes("压到") || calls > 1) {
        return {
          ok: true,
          text: "",
          json: { body: "## 我自己\n还想你。" },
          toolCalls: [],
          raw: {},
          model: "test",
          effort: "medium" as const,
          ms: 1,
        };
      }
      return {
        ok: true,
        text: "",
        json: {
          ops: [{ section: "## 我自己", action: "add", old: "", new: "x".repeat(5000) }],
        },
        toolCalls: [],
        raw: {},
        model: "test",
        effort: "medium" as const,
        ms: 1,
      };
    }) as typeof callModel;
    const ran = await runEditor("manual", complete);
    assert.equal(ran.batches, 1);
    const row = await getDossier();
    assert.equal(row.cursorAt, t0);
    assert.equal(row.turnsSinceEdit, 0);
    assert.match(row.body, /还想你/);
    const versions = await listDossierVersions();
    assert.equal(versions.some((version) => version.author === "compact"), true);
    assert.equal(versions.some((version) => version.author === "editor"), true);
  } finally {
    setClock(null);
    await iso.close();
  }
});

test("clear forgets only messages past the dossier cursor once it is on", async () => {
  const iso = await openIsolatedSql();
  const t0 = Date.UTC(2026, 8, 22, 12, 0, 0);
  const t1 = t0 + 5_000;
  try {
    setClock(() => t0);
    await upsertMessage({ id: "old", role: "user", text: "旧的", createdAt: t0, timeZone: TZ });
    await enableDossier("## 我们\n旧的还在。\n");
    await upsertMessage({ id: "new", role: "user", text: "新的", createdAt: t1, timeZone: TZ });
    setClock(() => t1 + 10);
    await clearRecentConversation();
    const rows = await (await import("./store.ts")).sql().then((db) =>
      db.query<{ id: string; forgotten_at: number | null }>(
        "select id, forgotten_at from qingran_messages order by id",
      ),
    );
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    assert.equal(byId.old!.forgotten_at, null);
    assert.ok(byId.new!.forgotten_at);
    const dossier = await getDossier();
    assert.match(dossier.body, /旧的还在/);
  } finally {
    setClock(null);
    await iso.close();
  }
});

test("a rosie edit keeps a version and a seed draft does not activate", async () => {
  const iso = await openIsolatedSql();
  try {
    await saveDossierBody("## 我自己\n手改。\n", "rosie");
    const live = await getDossier();
    assert.equal(live.active, false);
    assert.match(live.body, /手改/);
    const draft = await seedDossierDraft(fake({ body: "## 我们\n草稿。\n" }));
    assert.equal(draft.author, "seed");
    const after = await getDossier();
    assert.equal(after.active, false);
    assert.match(after.body, /手改/);
    assert.match(draft.body, /草稿/);
  } finally {
    await iso.close();
  }
});

test("an inactive seed draft becomes the live dossier without another generation", async () => {
  const iso = await openIsolatedSql();
  const t0 = Date.UTC(2026, 8, 23, 12, 0, 0);
  try {
    setClock(() => t0);
    await upsertMessage({ id: "m1", role: "user", text: "在", createdAt: t0, timeZone: TZ });
    await seedDossierDraft(fake({ body: "## 我们\n草稿。\n" }));
    assert.equal((await getDossier()).active, false);
    let called = 0;
    const boom = (async () => {
      called += 1;
      throw new Error("should not seed");
    }) as typeof callModel;
    assert.equal(await ensureDossierLive(boom), "draft");
    assert.equal(called, 0);
    const row = await getDossier();
    assert.equal(row.active, true);
    assert.equal(row.cursorAt, t0);
    assert.match(row.body, /草稿/);
  } finally {
    setClock(null);
    await iso.close();
  }
});

test("an inactive dossier with no draft is generated and then live", async () => {
  const iso = await openIsolatedSql();
  const t0 = Date.UTC(2026, 8, 24, 12, 0, 0);
  try {
    setClock(() => t0);
    await upsertMessage({ id: "m2", role: "user", text: "嗯", createdAt: t0, timeZone: TZ });
    assert.equal(await ensureDossierLive(fake({ body: "## 我自己\n生成的。\n" })), "seeded");
    const row = await getDossier();
    assert.equal(row.active, true);
    assert.equal(row.cursorAt, t0);
    assert.match(row.body, /生成的/);
    const versions = await listDossierVersions();
    assert.equal(versions.some((version) => version.author === "seed"), true);
  } finally {
    setClock(null);
    await iso.close();
  }
});

test("a live dossier is not seeded again", async () => {
  const iso = await openIsolatedSql();
  try {
    await enableDossier("## 我们\n已经在用。\n");
    let called = 0;
    const boom = (async () => {
      called += 1;
      throw new Error("should not seed");
    }) as typeof callModel;
    assert.equal(await ensureDossierLive(boom), "already");
    assert.equal(called, 0);
    assert.equal(await enqueueDossierActivate(), false);
    const row = await getDossier();
    assert.equal(row.active, true);
    assert.match(row.body, /已经在用/);
  } finally {
    await iso.close();
  }
});

test("a saved body goes live without a new seed", async () => {
  const iso = await openIsolatedSql();
  try {
    await saveDossierBody("## 我自己\n手写。\n", "rosie");
    let called = 0;
    const boom = (async () => {
      called += 1;
      throw new Error("should not seed");
    }) as typeof callModel;
    assert.equal(await ensureDossierLive(boom), "kept");
    assert.equal(called, 0);
    const row = await getDossier();
    assert.equal(row.active, true);
    assert.match(row.body, /手写/);
  } finally {
    await iso.close();
  }
});

test("the activate job is queued once while the dossier is still off", async () => {
  const iso = await openIsolatedSql();
  try {
    assert.equal(await enqueueDossierActivate(), true);
    assert.equal(await enqueueDossierActivate(), false);
    const rows = await (await import("./store.ts")).sql().then((db) =>
      db.query<{ dedupe_key: string }>("select dedupe_key from brain_jobs where dedupe_key = 'dossier:activate'"),
    );
    assert.equal(rows.length, 1);
  } finally {
    await iso.close();
  }
});
