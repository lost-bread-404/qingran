import assert from "node:assert/strict";
import { test } from "node:test";
import { setClock } from "./clock.ts";
import { SESSION_GAP_MS } from "./config.ts";
import { openIsolatedSql } from "./eval-db.ts";
import { runArchivist } from "./archivist.ts";
import { rebuildArchiveInput, rebuildReflectorInput, rebuildVoiceMessages } from "./rebuild.ts";
import {
  bumpNotesVersion,
  patchMeta,
  updateMessageText,
  upsertDay,
  upsertMessage,
  upsertNote,
  upsertPortrait,
} from "./store.ts";
import type { Note } from "./types.ts";
import { loadHotContext } from "./voice/pack.ts";
import { runReflector } from "./voice/reflector.ts";
import { recordVoiceTurn } from "./voice-log.ts";
import { DEFAULT_PROFILE, lockedProfile } from "../types.ts";
import { resetSpendSnap } from "./spend/ledger.ts";

const TZ = "America/New_York";
process.env.XAI_API_KEY = "mock";

function makeNote(id: string, text: string, at: number): Note {
  return {
    id,
    text,
    tags: ["论文"],
    aliases: [],
    subject: "rosie",
    lens: ["diary"],
    fromRosie: true,
    weight: 4,
    status: "active",
    supersededBy: null,
    links: [],
    happenedAt: at,
    localDay: "2026-09-16",
    sourceIds: [],
    recallCount: 0,
    lastRecalledAt: null,
    createdAt: at,
    updatedAt: at,
  };
}

function mindPayload(_text: string, ids: string[]) {
  return {
    insight: "她把累说成懒，其实是怕自己不够好",
    memory_ids: ids,
  };
}

test("rebuild matches captured voice/reflect/archive bodies after later mutations", async () => {
  const iso = await openIsolatedSql();
  resetSpendSnap();
  const captured = { voice: [] as string[], reflect: [] as string[], archive: [] as string[] };
  const realFetch = globalThis.fetch;
  process.env.QR_CARE_CHECKIN = "true";
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (!u.startsWith("https://api.x.ai/")) throw new Error(`blocked ${u}`);
    if (u.endsWith("/v1/models")) {
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      text?: { format?: { name?: string } };
      input?: Array<{ role?: string; content: string }>;
      store?: boolean;
    };
    assert.equal(body.store, false);
    const name = body.text?.format?.name ?? "";
    if (name === "mind") captured.reflect.push(JSON.stringify(body.input ?? []));
    if (name === "archive_ops") captured.archive.push(JSON.stringify(body.input ?? []));
    const lastUser = [...(body.input ?? [])].reverse().find((m) => m.role === "user")?.content ?? "";
    const ids = [...lastUser.matchAll(/^([\w:-]+)\|/gm)].map((m) => m[1]!).slice(0, 3);
    const out =
      name === "archive_ops"
        ? { ops: [] }
        : mindPayload(lastUser.slice(-20), ids);
    return new Response(JSON.stringify({ output_text: JSON.stringify(out), usage: { input_tokens: 20, output_tokens: 10 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const profile = lockedProfile(DEFAULT_PROFILE);
  const t0 = Date.UTC(2026, 8, 16, 19, 0, 0);
  try {
    setClock(() => t0);
    await patchMeta({ timeZone: TZ, selfSummary: "我在医学院", bondSummary: "叫她小猫" });
    await upsertPortrait({
      id: "p1",
      topic: "安慰",
      body: "别讲道理",
      status: "active",
      kind: "trait",
      evidenceIds: [],
      lastSeen: t0,
      lastSupportedAt: t0,
      supportCount: 1,
      updatedAt: t0,
    });

    async function voiceTurn(at: number, text: string, userId: string) {
      setClock(() => at);
      const ctx = await loadHotContext({
        text,
        userMsgId: userId,
        userCreatedAt: at,
        profile,
        nowMs: at,
        timeZone: TZ,
      });
      captured.voice.push(JSON.stringify(ctx.messages));
      await upsertMessage({ id: `a:${at}`, role: "assistant", text: "我在。", createdAt: at, timeZone: TZ });
      await recordVoiceTurn({
        ctx,
        replyId: `a:${at}`,
        display: "我在。",
        failed: false,
        model: "voice",
        usage: { tokensIn: 10, tokensCached: 0, tokensOut: 4, tokensReasoning: 0, costTicks: null },
        totalMs: 12,
        ttftMs: 5,
        firstAudioMs: null,
        userCreatedAt: at,
        userMsgId: userId,
        localDay: "2026-09-16",
      });
      await runReflector(at);
      return ctx;
    }

    await voiceTurn(t0, "今晚不想动", "u:empty");

    const t1 = t0 + 60_000;
    setClock(() => t1);
    await upsertNote(makeNote("n-paper", "Rosie 晚上想写论文但一直开始不了", t1));
    await bumpNotesVersion();
    await upsertDay({
      day: "2026-09-16",
      summary: "",
      energy: null,
      mood: null,
      body: null,
      did: [],
      avoided: [],
      events: [],
      wins: [],
      firstActive: t1,
      lastActive: t1,
      msgCount: 2,
      coverage: "thin",
      noteIds: ["n-paper"],
      version: 1,
      updatedAt: t1,
    });
    const ctxCare = await voiceTurn(t1, "论文一个字都没写，今天过得乱七八糟", "u:care");
    assert.equal(ctxCare.careHint, true);
    assert.equal(ctxCare.fallbackIds.length, 0);

    const t2 = t1 + SESSION_GAP_MS + 60_000;
    setClock(() => t2);
    const ctxStale = await voiceTurn(t2, "隔了很久我又回来了", "u:stale");
    assert.equal(ctxStale.mindStale, true);

    await runArchivist(["u:empty", "u:care", "u:stale", `a:${t0}`, `a:${t1}`, `a:${t2}`]);
    assert.ok(captured.archive.length >= 1);

    setClock(() => t2 + 5_000);
    await updateMessageText("u:care", "论文其实写了一点");
    await upsertNote(makeNote("n-paper", "改过的笔记", t2 + 5_000));
    await bumpNotesVersion();
    await upsertPortrait({
      id: "p1",
      topic: "安慰",
      body: "完全改了",
      status: "active",
      kind: "trait",
      evidenceIds: [],
      lastSeen: t2,
      lastSupportedAt: t2,
      supportCount: 1,
      updatedAt: t2,
    });
    await iso.sql.query(`update qingran_profile set data = data || '{"systemPrompt":"新的人设"}'::jsonb where id = 1`);
    await patchMeta({ selfSummary: "改了自己", bondSummary: "改了我们" });

    for (const turnSeq of [t0, t1, t2]) {
      const rebuilt = await rebuildVoiceMessages(turnSeq);
      const orig = captured.voice.find((_, i) => [t0, t1, t2][i] === turnSeq) ?? "";
      assert.equal(JSON.stringify(rebuilt.messages), orig, `voice ${turnSeq} ${rebuilt.warnings.join(";")}`);
    }
    assert.equal(captured.reflect.length, 3);
    for (let i = 0; i < 3; i++) {
      const seq = [t0, t1, t2][i]!;
      const rebuilt = await rebuildReflectorInput(seq);
      assert.equal(JSON.stringify(rebuilt.messages), captured.reflect[i], `reflect ${seq} ${rebuilt.warnings.join(";")}`);
    }
    const logs = await iso.sql.query<{ id: number }>(`select id from brain_log where route = 'archive' order by id`);
    assert.ok(logs[0]);
    const rebuiltA = await rebuildArchiveInput(Number(logs[0]!.id));
    assert.equal(JSON.stringify(rebuiltA.messages), captured.archive[0], rebuiltA.warnings.join(";"));

    const high = await iso.sql.query<{ input_system: string | null; input_user: string | null; route: string }>(
      `select route, input_system, input_user from brain_log where route in ('voice','reflect','archive')`,
    );
    assert.ok(high.length >= 1);
    for (const row of high) {
      assert.ok(row.input_system || row.input_user, row.route);
    }
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.QR_CARE_CHECKIN;
    setClock(null);
    await iso.close();
  }
});
