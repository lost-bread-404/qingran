#!/usr/bin/env node
/**
 * Re-run clips through xAI STT under vad_threshold 0 / 0.3 / 0.5
 * with and without prompt-extracted keyterms (e.g. 林泽), plus the
 * production slim keyterm list at vad 0.3.
 *
 *   node scripts/xai-hallucination-compare.mjs path/to/export.json
 *
 * Prints a markdown table. Requires XAI_API_KEY.
 *
 * NEW_FIXED must stay in sync with src/lib/lover/hearing/config.ts STT_KEYTERMS.
 */
import { readFile } from "node:fs/promises";

const STT_URL = "https://api.x.ai/v1/stt";
const MODEL = "grok-voice-transcribe-2.0";
const LEGACY_FIXED = [
  "嗯", "啊", "呜", "哈", "哼", "嗷", "哦", "唉", "嘛", "呀", "啦", "呢", "吧", "喵",
  "嗯嗯", "嗯嗯嗯", "啊啊", "呜呜", "哈哈", "喵喵",
  "清然", "Rosie", "姐姐", "小猫", "林泽",
];
const NEW_FIXED = [
  "姐姐", "清然", "小猫", "Rosie",
  "嗯", "啊", "呜", "哈", "哼", "哦", "唉", "嘛", "呀", "啦", "呢", "吧", "喵",
  "嗷", "嗷呜", "喵呜", "呜喵",
];
const PROMPT_EXTRA = ["林泽", "信息素", "Omega", "Rosie"];
const FILLER = /[嗯唔呜啊哦噢喔额呃唉哎诶欸哼哈嘿哇呀哟呦切啧嘶嘛呢吧啦咯嘞嘤喵嗷呼嘻嗨嘘咿欧咕唧呐]/;
const STACKED_FILLER = /^(嗯{2,}|啊{2,}|呜{2,}|哈{2,}|喵{2,})$/;

const RUNS = [
  { key: "vad0+prompt", vad: 0, terms: unique([...PROMPT_EXTRA, ...LEGACY_FIXED]) },
  { key: "vad0", vad: 0, terms: LEGACY_FIXED },
  { key: "vad0.3+prompt", vad: 0.3, terms: unique([...PROMPT_EXTRA, ...LEGACY_FIXED]) },
  { key: "vad0.3", vad: 0.3, terms: LEGACY_FIXED },
  { key: "vad0.5+prompt", vad: 0.5, terms: unique([...PROMPT_EXTRA, ...LEGACY_FIXED]) },
  { key: "vad0.5", vad: 0.5, terms: LEGACY_FIXED },
  { key: "vad0.3+new", vad: 0.3, terms: NEW_FIXED },
];

function unique(list) {
  return [...new Set(list)];
}

function stripMarks(text) {
  return String(text ?? "").replace(/[，。！？、,.!?;；：:\s………~～"'“”‘’]+/g, "");
}

function isFiller(text) {
  const core = stripMarks(text);
  if (!core) return true;
  return [...core].every((ch) => FILLER.test(ch));
}

function isStackedFiller(text) {
  return STACKED_FILLER.test(stripMarks(text));
}

function looksHallucinated(text) {
  const core = stripMarks(text);
  return core.length > 6 && !isFiller(text);
}

async function transcribe({ audioBase64, vad, keyterms }) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error("XAI_API_KEY is required");
  const bytes = Buffer.from(audioBase64, "base64");
  const form = new FormData();
  form.append("model", MODEL);
  form.append("filler_words", "true");
  form.append("vad_threshold", String(vad));
  for (const term of keyterms) {
    form.append("keyterm", term);
  }
  form.append("file", new Blob([bytes], { type: "audio/wav" }), "clip.wav");
  const started = Date.now();
  const res = await fetch(STT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const latency = Date.now() - started;
  if (!res.ok) {
    const body = await res.text();
    return { ok: false, text: "", error: `${res.status} ${body.slice(0, 180)}`, latency };
  }
  const body = await res.json();
  return { ok: true, text: String(body.text || body.transcript || "").trim(), latency };
}

function loadClips(raw) {
  const parsed = JSON.parse(raw);
  const clips = Array.isArray(parsed) ? parsed : parsed.clips;
  if (!Array.isArray(clips)) throw new Error("export json needs .clips[]");
  return clips
    .filter((clip) => clip.audioBase64)
    .map((clip) => ({
      id: clip.id,
      gold: clip.goldText || clip.gold_text || "",
      durationMs: clip.durationMs || clip.duration_ms || 0,
      audioBase64: clip.audioBase64,
      xaiText: clip.xaiText || clip.xai_text || "",
    }));
}

function cell(result) {
  if (!result.ok) return `ERR ${result.error}`;
  const text = result.text || "∅";
  if (looksHallucinated(result.text)) return `⚠ ${text}`;
  if (isStackedFiller(result.text)) return `叠语气词 ${text}`;
  if (isFiller(result.text) && result.text) return `语气词 ${text}`;
  return text;
}

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node scripts/xai-hallucination-compare.mjs export.json");
    process.exit(1);
  }
  const clips = loadClips(await readFile(path, "utf8")).slice(0, 80);
  const keys = RUNS.map((r) => r.key);
  console.log(`# xAI hallucination compare (${clips.length} clips)\n`);
  console.log(`| id | gold | dur ms | ${keys.join(" | ")} |`);
  console.log(`|---|---|---|${keys.map(() => "---").join("|")}|`);
  const tally = { hallu: {}, cueKept: {}, stacked: {} };
  for (const key of keys) {
    tally.hallu[key] = 0;
    tally.cueKept[key] = 0;
    tally.stacked[key] = 0;
  }
  for (const clip of clips) {
    const row = [clip.id, clip.gold || "—", String(clip.durationMs)];
    for (const run of RUNS) {
      const result = await transcribe({
        audioBase64: clip.audioBase64,
        vad: run.vad,
        keyterms: run.terms,
      });
      row.push(cell(result));
      tally.hallu[run.key] += looksHallucinated(result.text) ? 1 : 0;
      tally.cueKept[run.key] += isFiller(clip.gold) && isFiller(result.text) && result.text ? 1 : 0;
      tally.stacked[run.key] += isStackedFiller(result.text) ? 1 : 0;
      await new Promise((r) => setTimeout(r, 120));
    }
    console.log(`| ${row.join(" | ")} |`);
  }
  console.log("\n## totals\n");
  console.log("| config | hallucination sentences | filler gold kept as filler | stacked filler (嗯嗯嗯/啊啊…) |");
  console.log("|---|---|---|---|");
  for (const key of keys) {
    console.log(`| ${key} | ${tally.hallu[key]} | ${tally.cueKept[key]} | ${tally.stacked[key]} |`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
