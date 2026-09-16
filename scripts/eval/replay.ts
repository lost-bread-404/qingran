/**
 * Eval replay: isolated PGLite, scripted clock, talk hot-path + slow-path per turn.
 * No TTS. Requires XAI_API_KEY.
 *
 *   node --experimental-strip-types scripts/eval/replay.ts scenarios/recall.jsonl
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setClock } from "../../src/lib/lover/brain/clock.ts";
import { LONG_DRAIN_MS } from "../../src/lib/lover/brain/config.ts";
import { resolveRoute } from "../../src/lib/lover/brain/config.ts";
import { openIsolatedSql } from "../../src/lib/lover/brain/eval-db.ts";
import { enqueueArchiveIfNeeded } from "../../src/lib/lover/brain/archivist.ts";
import { enqueuePeriodicIfDue } from "../../src/lib/lover/brain/diary/dusk.ts";
import { drainJobs, enqueue } from "../../src/lib/lover/brain/jobs.ts";
import {
  listDays,
  listEpisodes,
  listFactors,
  listFindings,
  listIntentions,
  upsertMessage,
} from "../../src/lib/lover/brain/store.ts";
import { loadHotContext } from "../../src/lib/lover/brain/voice/pack.ts";
import { DEFAULT_PROFILE, lockedProfile } from "../../src/lib/lover/types.ts";

export type ScenarioTurn = { at: number; user: string };

const TZ = "America/New_York";

export async function completeVoice(
  messages: Array<{ role: string; content: string }>,
): Promise<{ text: string; ttftMs: number }> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error("XAI_API_KEY is required");
  const route = resolveRoute("voice");
  const t0 = Date.now();
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: route.model,
      temperature: 0.85,
      max_tokens: route.maxOutput,
      stream: true,
      messages,
    }),
    signal: AbortSignal.timeout(route.timeoutMs),
  });
  if (!res.ok || !res.body) throw new Error(`voice http ${res.status}: ${await res.text()}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let ttftMs = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const piece = json.choices?.[0]?.delta?.content ?? "";
        if (piece) {
          if (!ttftMs) ttftMs = Date.now() - t0;
          text += piece;
        }
      } catch {
        /* ignore keep-alive */
      }
    }
  }
  return { text: text.trim(), ttftMs: ttftMs || Date.now() - t0 };
}

export async function replayFile(
  scenarioPath: string,
  outDir: string,
): Promise<{
  name: string;
  packMs: number[];
  ttftMs: number[];
  replies: string[];
  isDiary: boolean;
}> {
  const name = basename(scenarioPath).replace(/\.jsonl$/, "");
  const turns = readFileSync(scenarioPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ScenarioTurn);
  const isolated = await openIsolatedSql();
  const packMs: number[] = [];
  const ttftMs: number[] = [];
  const replies: string[] = [];
  const transcript: Array<{ role: "user" | "assistant"; text: string; createdAt: number }> = [];
  const profile = lockedProfile(DEFAULT_PROFILE);
  try {
    for (const turn of turns) {
      setClock(() => turn.at);
      const ctx = await loadHotContext({
        text: turn.user,
        userMsgId: `u:${turn.at}`,
        userCreatedAt: turn.at,
        profile,
        nowMs: turn.at,
        timeZone: TZ,
      });
      packMs.push(ctx.packMs);
      const voice = await completeVoice(ctx.messages);
      ttftMs.push(voice.ttftMs);
      replies.push(voice.text);
      if (voice.text) {
        await upsertMessage({
          id: `a:${turn.at}`,
          role: "assistant",
          text: voice.text.slice(0, 4000),
          createdAt: turn.at + 1,
          timeZone: TZ,
        });
      }
      transcript.push({ role: "user", text: turn.user, createdAt: turn.at });
      if (voice.text) {
        transcript.push({ role: "assistant", text: voice.text, createdAt: turn.at + 1 });
      }
      await enqueue("reflect", `reflect:${turn.at}`, { turnSeq: turn.at });
      await enqueueArchiveIfNeeded(turn.at);
      await enqueuePeriodicIfDue(turn.at, TZ);
      await drainJobs(LONG_DRAIN_MS);
    }
  } finally {
    setClock(null);
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${name}.transcript.json`), JSON.stringify(transcript, null, 2));
  writeFileSync(
    join(outDir, `${name}.timing.json`),
    JSON.stringify({ pack_ms: packMs, ttft_ms: ttftMs }, null, 2),
  );
  const isDiary = name.startsWith("diary-");
  if (isDiary) {
    const [days, intentions, episodes, findings, factors] = await Promise.all([
      listDays("1970-01-01", "2099-12-31"),
      listIntentions(),
      listEpisodes(),
      listFindings(),
      listFactors(false),
    ]);
    const names = new Map(factors.map((f) => [f.id, f.name]));
    writeFileSync(
      join(outDir, `${name}.diary.json`),
      JSON.stringify(
        {
          days,
          intentions,
          episodes,
          findings: findings.filter((f) => f.tier === "finding"),
          clues: findings.filter((f) => f.tier === "clue"),
          factorNames: Object.fromEntries(names),
        },
        null,
        2,
      ),
    );
  }
  await isolated.close();
  return { name, packMs, ttftMs, replies, isDiary };
}

export type ScenarioTurnFile = ScenarioTurn;

if (import.meta.url === `file://${process.argv[1]}`) {
  const rel = process.argv[2];
  if (!rel) {
    console.error("usage: replay.ts <scenario.jsonl>");
    process.exit(1);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const path = rel.startsWith("/") ? rel : join(here, rel);
  const outDir = join(here, "../../out");
  replayFile(path, outDir).then(
    (r) => {
      console.log(`[replay] ${r.name} turns=${r.replies.length} pack_p50=${pct(r.packMs, 0.5)}`);
    },
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}

function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]!;
}
