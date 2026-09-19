#!/usr/bin/env node
/**
 * Re-run clips through xAI STT under vad_threshold 0 / 0.3 / 0.5
 * with and without prompt-extracted keyterms (e.g. 林泽).
 *
 *   node scripts/xai-hallucination-compare.mjs path/to/export.json
 *
 * Prints a markdown table. Requires XAI_API_KEY.
 */
import { readFile } from "node:fs/promises";

const STT_URL = "https://api.x.ai/v1/stt";
const MODEL = "grok-voice-transcribe-2.0";
const FIXED = [
  "嗯", "啊", "呜", "哈", "哼", "嗷", "哦", "唉", "嘛", "呀", "啦", "呢", "吧", "喵",
  "嗯嗯", "嗯嗯嗯", "啊啊", "呜呜", "哈哈", "喵喵",
  "清然", "Rosie", "姐姐", "小猫", "林泽",
];
const PROMPT_EXTRA = ["林泽", "信息素", "Omega", "Rosie"];
const FILLER = /[嗯唔呜啊哦噢喔额呃唉哎诶欸哼哈嘿哇呀哟呦切啧嘶嘛呢吧啦咯嘞嘤喵嗷呼嘻嗨嘘咿欧咕唧呐]/;
const VADS = [0, 0.3, 0.5];

function stripMarks(text) {
  return String(text ?? "").replace(/[，。！？、,.!?;；：:\s………~～"'“”‘’]+/g, "");
}

function isFiller(text) {
  const core = stripMarks(text);
  if (!core) return true;
  return [...core].every((ch) => FILLER.test(ch));
}

function looksHallucinated(text) {
  const core = stripMarks(text);
  return core.length > 6 && !isFiller(text);
}

async function transcribe({ audioBase64, vad, extraKeyterms }) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error("XAI_API_KEY is required");
  const bytes = Buffer.from(audioBase64, "base64");
  const form = new FormData();
  form.append("model", MODEL);
  form.append("filler_words", "true");
  form.append("vad_threshold", String(vad));
  for (const term of extraKeyterms ? [...new Set([...PROMPT_EXTRA, ...FIXED])] : FIXED) {
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
  console.log(`# xAI hallucination compare (${clips.length} clips)\n`);
  console.log("| id | gold | dur ms | vad0+prompt | vad0 | vad0.3+prompt | vad0.3 | vad0.5+prompt | vad0.5 |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  const tally = { hallu: {}, cueKept: {} };
  for (const clip of clips) {
    const row = [clip.id, clip.gold || "—", String(clip.durationMs)];
    for (const vad of VADS) {
      for (const extra of [true, false]) {
        const key = `vad${vad}${extra ? "+p" : ""}`;
        const result = await transcribe({ audioBase64: clip.audioBase64, vad, extraKeyterms: extra });
        row.push(cell(result));
        tally.hallu[key] = (tally.hallu[key] ?? 0) + (looksHallucinated(result.text) ? 1 : 0);
        tally.cueKept[key] =
          (tally.cueKept[key] ?? 0) + (isFiller(clip.gold) && isFiller(result.text) && result.text ? 1 : 0);
        await new Promise((r) => setTimeout(r, 120));
      }
    }
    console.log(`| ${row.join(" | ")} |`);
  }
  console.log("\n## totals\n");
  console.log("| config | hallucination sentences | filler gold kept as filler |");
  console.log("|---|---|---|");
  for (const key of Object.keys(tally.hallu)) {
    console.log(`| ${key} | ${tally.hallu[key]} | ${tally.cueKept[key]} |`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
