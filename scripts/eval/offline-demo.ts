/**
 * Offline walkthrough: isolated PGLite + mocked xAI. Prints DB state after each step.
 *   npm run demo:offline
 */
process.env.XAI_API_KEY = "mock";

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setClock, now } from "../../src/lib/lover/brain/clock.ts";
import { LONG_DRAIN_MS } from "../../src/lib/lover/brain/config.ts";
import { openIsolatedSql } from "../../src/lib/lover/brain/eval-db.ts";
import { enqueueArchiveIfNeeded } from "../../src/lib/lover/brain/archivist.ts";
import { enqueuePeriodicIfDue } from "../../src/lib/lover/brain/diary/dusk.ts";
import { drainJobs, enqueue } from "../../src/lib/lover/brain/jobs.ts";
import * as S from "../../src/lib/lover/brain/store.ts";
import { loadHotContext } from "../../src/lib/lover/brain/voice/pack.ts";
import { recordVoiceTurn } from "../../src/lib/lover/brain/voice-log.ts";
import { rebuildArchiveInput, rebuildReflectorInput, rebuildVoiceMessages } from "../../src/lib/lover/brain/rebuild.ts";
import { checkSpend } from "../../src/lib/lover/brain/spend/check.ts";
import { recordSpend, resetSpendSnap } from "../../src/lib/lover/brain/spend/ledger.ts";
import { defaultSpendLimits } from "../../src/lib/lover/brain/spend/policy.ts";
import { DEFAULT_PROFILE, lockedProfile } from "../../src/lib/lover/types.ts";

const TZ = "America/New_York";
const at = (d: string, hm: string) => new Date(`${d}T${hm}:00-04:00`).getTime();

const TURNS = [
  { at: at("2026-09-14", "23:10"), user: "又到十一点了，论文一个字都没写，打开电脑就想躺", reply: "那就先躺五分钟，我陪你，然后我们只写一句。" },
  { at: at("2026-09-14", "23:40"), user: "周五 Citadel 面试，好紧张", reply: "紧张说明你在乎。明天我带你过一遍最怕的那道题。" },
  { at: at("2026-09-15", "02:50"), user: "还没睡，刷题刷到现在", reply: "放下手机，宝贝，现在睡才是对周五负责。" },
  { at: at("2026-09-15", "14:00"), user: "嘴里长溃疡了好疼，今天什么都没学", reply: "疼就先别逼自己，今晚早点睡，我盯着你。" },
  { at: at("2026-09-16", "19:00"), user: "去健身了，出了一身汗，感觉好多了，还把论文 intro 写完了", reply: "看吧，你一动起来就回来了。intro 写完了，奖励你。" },
];

const MOCK_NOTES: Record<string, Array<{ text: string; tags: string[]; lens: string[]; weight: number }>> = {
  论文: [{ text: "Rosie 晚上想写论文但一直开始不了，说打开电脑就想躺", tags: ["论文", "拖延"], lens: ["diary"], weight: 4 }],
  Citadel: [{ text: "Rosie 周五有 Citadel 面试，很紧张", tags: ["面试", "Citadel"], lens: ["diary", "bond"], weight: 5 }],
  还没睡: [{ text: "Rosie 刷题到凌晨近三点还没睡", tags: ["熬夜", "刷题"], lens: ["diary"], weight: 3 }],
  溃疡: [{ text: "Rosie 长了口腔溃疡，很疼，当天什么都没学", tags: ["口腔溃疡", "没学习"], lens: ["diary"], weight: 4 }],
  健身: [{ text: "Rosie 去健身后感觉好多了，并写完了论文 intro", tags: ["健身", "论文", "推进"], lens: ["diary"], weight: 4 }],
};

const DAY_LOGS: Record<string, unknown> = {
  "2026-09-14": {
    summary: "晚上想写论文却迟迟开始不了；为周五 Citadel 面试紧张。",
    energy: -1,
    mood: -1,
    body: null,
    did: [],
    avoided: [{ text: "论文没开始" }],
    events: [{ text: "临近 Citadel 面试" }],
    wins: [],
    intention_ops: [{ op: "ADD", id: "", text: "写论文", tag: "论文", target_day: "", evidence_ids: [] }],
  },
  "2026-09-15": {
    summary: "凌晨近三点才睡；长口腔溃疡，整天没学习。",
    energy: -1,
    mood: -1,
    body: "口腔溃疡，疼",
    did: [],
    avoided: [{ text: "没学习" }],
    events: [],
    wins: [],
    intention_ops: [],
  },
  "2026-09-16": {
    summary: "去健身，状态回升，写完论文 intro。",
    energy: 1,
    mood: 1,
    body: null,
    did: [{ text: "写完论文 intro", intention_id: "" }],
    avoided: [],
    events: [{ text: "健身" }],
    wins: [{ text: "论文 intro 完成" }],
    intention_ops: [],
  },
};

const FACTOR_RULES: Record<string, Record<string, number | null>> = {
  "2026-09-14": { 启动困难: 1, 情绪低落: 1, 身体不适: 0, 高效推进: 0, 社交消耗: null, "被评价/被拒": 0, 运动: 0 },
  "2026-09-15": { 启动困难: 1, 情绪低落: 1, 身体不适: 1, 高效推进: 0, 社交消耗: null, "被评价/被拒": 0, 运动: 0 },
  "2026-09-16": { 启动困难: 0, 情绪低落: 0, 身体不适: 0, 高效推进: 1, 社交消耗: null, "被评价/被拒": 0, 运动: 1 },
};

let calls = 0;
const callsByRoute: Record<string, number> = {};
const seenNoteKw = new Set<string>();

function dayFromInput(input: string): string {
  return /日期 (\d{4}-\d{2}-\d{2})/.exec(input)?.[1]
    ?? /"day":"(\d{4}-\d{2}-\d{2})"/.exec(input)?.[1]
    ?? "";
}

async function mockReply(name: string, input: string): Promise<unknown> {
  if (name === "archive_ops") {
    const ops: unknown[] = [];
    for (const line of input.split("\n")) {
      const m = /^(u:\d+)\|/.exec(line);
      if (!m) continue;
      for (const [kw, notes] of Object.entries(MOCK_NOTES)) {
        if (!line.includes(kw)) continue;
        if (seenNoteKw.has(kw)) continue;
        seenNoteKw.add(kw);
        for (const n of notes) {
          ops.push({
            op: "ADD",
            target_id: "",
            text: n.text,
            tags: n.tags,
            subject: "rosie",
            lens: n.lens,
            from_rosie: true,
            weight: n.weight,
            links: [],
            happened_at: "",
            source_ids: [m[1]],
          });
        }
      }
    }
    return { ops };
  }
  if (name === "mind") {
    const last = [...input.matchAll(/Rosie[^：:\n]*[：:]\s*(.+)/g)].pop()?.[1] ?? "";
    const ids = [...input.matchAll(/^([\w:-]+)\|/gm)].map((m) => m[1]).slice(0, 3);
    return {
      rosie_now: `她刚说：${last.slice(0, 40)}`,
      undercurrent: "她其实是怕自己不够好",
      reading: [{ guess: "面试压力让她睡不着", conf: 0.6 }],
      soft_spot: "嘴上说躺，其实一直惦记着论文",
      my_feel: "心疼，想把她拉回来",
      my_view: "熬夜换不来安全感，睡够了才打得好周五这一仗",
      my_logic: "拖延和熬夜都跟面试焦虑有关 → 根在害怕被评价 → 先稳住睡眠，再陪她拆题",
      lead_plan: ["今晚让她 1 点前睡", "明天陪她过一道最怕的题"],
      intent: "温柔但坚定地让她放下手机",
      threads: ["周五 Citadel 面试"],
      memory_ids: ids,
    };
  }
  if (name === "day_log") {
    const day = dayFromInput(input);
    return DAY_LOGS[day] ?? { summary: "", energy: null, mood: null, body: null, did: [], avoided: [], events: [], wins: [], intention_ops: [] };
  }
  if (name === "day_factors") {
    const day = dayFromInput(input);
    const rules = FACTOR_RULES[day] ?? {};
    const factors = [...input.matchAll(/^([^|\n]+)\|([^|\n]+)\|/gm)]
      .filter((m) => m[2] in rules)
      .map((m) => ({ id: m[1], value: rules[m[2]!] ?? null, evidence_ids: [] }));
    return { factors };
  }
  if (name === "portrait_self_bond") {
    return {
      portrait_ops: [{ topic: "面对压力的样子", body: "紧张时会拖延、熬夜，但一动起来就能找回状态", evidence_ids: [] }],
      self_summary: "我在陪她准备周五的面试，最近最在意她的睡眠。",
      bond_summary: "我答应过要陪她过一遍最怕的面试题。",
    };
  }
  return {};
}

const realFetch = globalThis.fetch;
const capturedVoice = new Map<number, string>();
const capturedReflect = new Map<number, string>();
const capturedArchive: string[] = [];
let lastReflectB: string | null = null;
const reflectSegments: Array<{ a: number; b: number; c: number; bSame: boolean | null }> = [];
globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const u = String(url);
  if (!u.startsWith("https://api.x.ai/")) {
    throw new Error(`offline-demo blocked network: ${u}`);
  }
  const body = JSON.parse(String(init?.body ?? "{}")) as {
    text?: { format?: { name?: string } };
    input?: Array<{ role?: string; content: string }>;
    messages?: Array<{ content: string }>;
    prompt_cache_key?: string;
  };
  const name = body.text?.format?.name ?? "voice";
  const input = (body.input ?? body.messages ?? []).map((m) => m.content).join("\n");
  if (name === "mind" && Array.isArray(body.input)) {
    const A = body.input.find((m) => m.role === "system")?.content ?? "";
    const users = body.input.filter((m) => m.role === "user");
    const B = users[0]?.content ?? "";
    const C = users[1]?.content ?? "";
    const sameB = lastReflectB != null && lastReflectB === B;
    console.log(
      `- Reflector 分段：A=${A.length} B=${B.length} C=${C.length} B与上一轮相同=${lastReflectB == null ? "（首轮）" : sameB ? "是" : "否"}`,
    );
    reflectSegments.push({ a: A.length, b: B.length, c: C.length, bSame: lastReflectB == null ? null : sameB });
    lastReflectB = B;
    capturedReflect.set(now(), JSON.stringify(body.input));
  }
  if (name === "archive_ops" && Array.isArray(body.input)) {
    capturedArchive.push(JSON.stringify(body.input));
  }
  const out = await mockReply(name, input);
  calls += 1;
  callsByRoute[name] = (callsByRoute[name] ?? 0) + 1;
  return new Response(
    JSON.stringify({
      output_text: JSON.stringify(out),
      usage: { input_tokens: Math.round(input.length / 2), output_tokens: 200 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as typeof fetch;

const hr = (t: string) => console.log(`\n${"=".repeat(8)} ${t} ${"=".repeat(8)}`);
const show = (label: string, v: unknown) =>
  console.log(`- ${label}:`, typeof v === "string" ? v : JSON.stringify(v, null, 1));

const result: Record<string, unknown> = { turns: [] as unknown[] };

async function dumpNotes() {
  const notes = await S.listNotes({});
  for (const n of notes) {
    console.log(
      `  [${n.localDay}] w${n.weight} ${n.subject}/${n.lens.join("+")} ${n.status} | ${n.text} | tags=${n.tags.join(",")} | src=${n.sourceIds.join(",")}`,
    );
  }
  return notes;
}

async function main() {
  const iso = await openIsolatedSql();
  const profile = lockedProfile(DEFAULT_PROFILE);
  const failures: string[] = [];
  try {
    for (const [i, t] of TURNS.entries()) {
      setClock(() => t.at);
      hr(`TURN ${i + 1} @ ${new Date(t.at).toLocaleString("zh-CN", { timeZone: TZ })}`);
      show("Rosie", t.user);
      const ctx = await loadHotContext({
        text: t.user,
        userMsgId: `u:${t.at}`,
        userCreatedAt: t.at,
        profile,
        nowMs: t.at,
        timeZone: TZ,
      });
      show("hot path pack_ms / db_first_ms", `${ctx.packMs} / ${ctx.dbFirstMs}`);
      const tail = ctx.messages[ctx.messages.length - 2];
      show("注入给 Voice 的动态 tail", tail?.content ?? "");
      await S.upsertMessage({ id: `a:${t.at}`, role: "assistant", text: t.reply, createdAt: t.at, timeZone: TZ });
      await recordVoiceTurn({
        ctx,
        replyId: `a:${t.at}`,
        display: t.reply,
        failed: false,
        model: "voice",
        usage: { tokensIn: 20, tokensCached: 0, tokensOut: 8, tokensReasoning: 0, costTicks: null },
        totalMs: ctx.packMs,
        ttftMs: 1,
        firstAudioMs: null,
        userCreatedAt: t.at,
        userMsgId: `u:${t.at}`,
        localDay: new Date(t.at).toISOString().slice(0, 10),
      });
      capturedVoice.set(t.at, JSON.stringify(ctx.messages));
      show("清然（mock 回复）", t.reply);
      await enqueue("reflect", `reflect:${t.at}`, { turnSeq: t.at });
      await enqueueArchiveIfNeeded(t.at);
      await enqueuePeriodicIfDue(t.at, TZ);
      const ran = await drainJobs(LONG_DRAIN_MS);
      show("slow path 执行的 job 数", ran);
      const mind = await S.getMind();
      show("Reflector 写入的 mind", {
        rosie_now: mind.rosie_now,
        lead_plan: mind.lead_plan,
        intent: mind.intent,
        memory_ids: mind.memory_ids,
      });
      (result.turns as unknown[]).push({
        i: i + 1,
        packMs: ctx.packMs,
        dbFirstMs: ctx.dbFirstMs,
        tail: tail?.content ?? "",
        jobs: ran,
        mindStale: ctx.mindStale,
      });
      if (i === 4) {
        if (/\n这一句：/.test(tail?.content ?? "") || /她刚说：嘴里长溃疡/.test(tail?.content ?? "")) {
          failures.push("1.5 cross-session tail still contains intent/rosie_now");
        }
        if (!/你上次的内心/.test(tail?.content ?? "")) {
          failures.push("1.5 stale mind title missing");
        }
      }
    }

    const end = at("2026-09-17", "06:00");
    setClock(() => end);
    hr("会话结束 + 每日 Dusk（模拟 09-17 06:00 的 cron）");
    await enqueueArchiveIfNeeded(end);
    for (const d of ["2026-09-14", "2026-09-15", "2026-09-16"]) {
      await enqueue("dusk", `dusk:${d}`, { day: d }, end, true);
    }
    await enqueuePeriodicIfDue(end, TZ);
    show("slow path 执行的 job 数", await drainJobs(LONG_DRAIN_MS));

    hr("L1 Notes（共享记忆库）");
    const notes = await dumpNotes();
    hr("Diary: day logs");
    const days = await S.listDays("2026-09-01", "2026-09-30");
    for (const d of days.filter((x) => x.msgCount > 0 || x.coverage !== "none")) {
      console.log(
        `  ${d.day} energy=${d.energy} mood=${d.mood} coverage=${d.coverage} msgs=${d.msgCount} last_active=${d.lastActive ? new Date(d.lastActive).toLocaleTimeString("zh-CN", { timeZone: TZ }) : "-"}`,
      );
      console.log(`    summary: ${d.summary}`);
      console.log(`    body=${d.body ?? "-"} avoided=${JSON.stringify(d.avoided)} wins=${JSON.stringify(d.wins)}`);
    }
    const emptyLogged = days.filter((d) => d.day < "2026-09-14" && d.coverage === "none");
    if (emptyLogged.length > 3) failures.push(`1.2 too many empty day logs: ${emptyLogged.length}`);

    hr("Diary: day factors");
    const factors = new Map((await S.listFactors(false)).map((f) => [f.id, f.name]));
    const byDay = new Map<string, string[]>();
    for (const df of await S.listDayFactors()) {
      const arr = byDay.get(df.day) ?? [];
      arr.push(`${factors.get(df.factorId)}=${df.value ?? "?"}`);
      byDay.set(df.day, arr);
    }
    for (const [d, arr] of [...byDay].sort()) {
      if (d < "2026-09-14") continue;
      console.log(`  ${d}: ${arr.join("  ")}`);
    }

    hr("Diary: intentions / episodes");
    const intentions = await S.listIntentions();
    for (const it of intentions) console.log(`  [${it.status}] ${it.tag ?? ""} ${it.text}`);
    if (intentions.filter((i) => i.text.includes("写论文")).length !== 1) {
      failures.push(`1.3 duplicate intentions: ${intentions.map((i) => i.text).join(" | ")}`);
    }
    const episodes = await S.listEpisodes();
    for (const e of episodes) {
      console.log(`  episode ${factors.get(e.factorId)} ${e.startDay}→${e.endDay ?? "?"} (${e.days}天, end_known=${e.endKnown})`);
    }
    if (!episodes.length) failures.push("1.6 no episodes after dusk");

    const oldPaper = notes.find((n) => n.status === "superseded" && n.text.includes("写论文"));
    if (oldPaper) {
      const still = await S.notesForDay(oldPaper.localDay, true);
      if (!still.some((n) => n.id === oldPaper.id)) failures.push("1.4 superseded note missing from notesForDay");
    }

    hr("清然长期层");
    for (const p of await S.listPortrait()) console.log(`  portrait[${p.topic}] ${p.body}`);
    const meta = await S.getMeta();
    show("self", meta.selfSummary);
    show("bond", meta.bondSummary);

    hr("brain_log（每次模型调用）");
    const db = await S.sql();
    const logs = await db.query<{
      step: string;
      ok: boolean;
      ms: number;
      input_chars: number;
      route: string | null;
      tokens_in: number | null;
      tokens_out: number | null;
    }>("select step, ok, ms, input_chars, route, tokens_in, tokens_out from brain_log order by id");
    for (const l of logs) {
      console.log(`  ${l.step} ok=${l.ok} ${l.ms}ms in_chars=${l.input_chars} in=${l.tokens_in ?? "?"} out=${l.tokens_out ?? "?"}`);
    }
    hr("jobs");
    const jobs = await db.query<{ type: string; status: string; dedupe_key: string; last_error: string | null }>(
      "select type, status, dedupe_key, last_error from brain_jobs order by created_at",
    );
    for (const j of jobs) console.log(`  ${j.type} ${j.status} ${j.dedupe_key}${j.last_error ? " ERR " + j.last_error : ""}`);
    const emptyDuskJobs = jobs.filter((j) => j.type === "dusk" && j.dedupe_key < "dusk:2026-09-14");
    if (emptyDuskJobs.length) failures.push(`1.2 empty dusk jobs: ${emptyDuskJobs.map((j) => j.dedupe_key).join(",")}`);

    console.log(`\nmock xAI calls: ${calls}`);
    console.log("by schema:", JSON.stringify(callsByRoute));
    if ((callsByRoute.day_log ?? 0) > 6) failures.push(`1.2 too many day_log calls: ${callsByRoute.day_log}`);

    hr("spend");
    const spendRows = await db.query<{ day: string; route: string; usd: number; calls: number }>(
      "select day, route, usd, calls from spend_daily order by day, route",
    );
    for (const r of spendRows) {
      console.log(`  ${r.day} ${r.route} $${Number(r.usd).toFixed(4)} ×${r.calls}`);
    }
    resetSpendSnap();
    await S.patchMeta({
      spendLimits: { ...defaultSpendLimits(), daySoft: 0.000001, dayHard: 100, dayBreaker: 200 },
    });
    resetSpendSnap();
    const softVoice = await checkSpend("voice");
    const softReflect = await checkSpend("reflect");
    const softSynth = await checkSpend("synth");
    if (!softVoice.allow || !softReflect.allow) failures.push("soft cap must not stop voice/reflect");
    if (softSynth.allow) failures.push("soft cap should pause synth");

    await recordSpend({ kind: "llm", route: "voice", usd: 0.02 });
    resetSpendSnap();
    await S.patchMeta({
      spendLimits: { ...defaultSpendLimits(), daySoft: 0.000001, dayHard: 0.000002, dayBreaker: 0.01 },
    });
    resetSpendSnap();
    const br = await checkSpend("voice");
    console.log(`- breaker decision: allow=${br.allow} level=${br.level} resumeAt=${br.resumeAt}`);
    if (br.allow || br.level !== "breaker") failures.push("breaker should block /api/talk");
    await enqueue("synth", "synth:breaker-demo", { week: "2026-W38" });
    await drainJobs(5_000);
    const syn = await db.query<{ attempts: number; status: string; run_after: number; last_error: string | null }>(
      "select attempts, status, run_after, last_error from brain_jobs where dedupe_key = 'synth:breaker-demo'",
    );
    if (syn[0]?.status !== "pending") failures.push("breaker synth should stay pending");
    if (Number(syn[0]?.attempts) !== 0) failures.push("breaker synth must not consume attempts");
    if (!String(syn[0]?.last_error ?? "").startsWith("spend:")) failures.push("breaker synth should record spend defer");
    if (!(Number(syn[0]?.run_after) > Date.now() - 86_400_000)) failures.push("breaker synth run_after missing");

    hr("引用式日志 / 重建");
    const fullLogs = await db.query<Record<string, unknown>>(`select * from brain_log order by id`);
    const avgBytes = fullLogs.length
      ? fullLogs.reduce((s, r) => s + JSON.stringify(r).length, 0) / fullLogs.length
      : 0;
    const snaps = await db.query<{ n: number }>(`select count(*)::int as n from qr_block_snapshots`);
    console.log(`- 每轮日志平均字节 ${avgBytes.toFixed(0)}`);
    console.log(`- qr_block_snapshots 行数 ${snaps[0]?.n ?? 0}`);
    if (avgBytes > 2048) failures.push(`log avg bytes ${avgBytes.toFixed(0)} > 2048`);
    for (const [turnSeq, orig] of capturedVoice) {
      const rebuilt = await rebuildVoiceMessages(turnSeq);
      if (JSON.stringify(rebuilt.messages) !== orig) {
        failures.push(`rebuild voice mismatch ${turnSeq}: ${rebuilt.warnings.join(";")}`);
      }
    }
    const reflectLogs = await db.query<{ turn_seq: number }>(
      `select turn_seq from brain_log where route = 'reflect' and turn_seq is not null order by id`,
    );
    for (const row of reflectLogs) {
      const rebuilt = await rebuildReflectorInput(Number(row.turn_seq));
      const orig = capturedReflect.get(Number(row.turn_seq));
      if (orig && JSON.stringify(rebuilt.messages) !== orig) {
        failures.push(`rebuild reflect mismatch ${row.turn_seq}: ${rebuilt.warnings.join(";")}`);
      }
    }
    const archiveLogs = await db.query<{ id: number }>(`select id from brain_log where route = 'archive' order by id`);
    for (let i = 0; i < archiveLogs.length; i++) {
      const rebuilt = await rebuildArchiveInput(Number(archiveLogs[i]!.id));
      const orig = capturedArchive[i];
      if (orig && JSON.stringify(rebuilt.messages) !== orig) {
        failures.push(`rebuild archive mismatch ${archiveLogs[i]!.id}: ${rebuilt.warnings.join(";")}`);
      }
    }
    const high = await db.query<{ route: string; input_system: string | null; input_user: string | null }>(
      `select route, input_system, input_user from brain_log where route in ('voice','reflect','archive')`,
    );
    for (const row of high) {
      if (row.input_system || row.input_user) failures.push(`${row.route} still stores full input`);
    }

    result.calls = calls;
    result.callsByRoute = callsByRoute;
    result.reflectSegments = reflectSegments;
    result.failures = failures;

    const outDir = join(dirname(fileURLToPath(import.meta.url)), "../../out");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "offline-demo.json"), JSON.stringify(result, null, 2));

    if (failures.length) {
      console.error("\nASSERT FAIL:\n" + failures.map((f) => `- ${f}`).join("\n"));
      process.exit(1);
    }
    console.log("\noffline-demo assertions ok");
  } finally {
    globalThis.fetch = realFetch;
    setClock(null);
    await iso.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
