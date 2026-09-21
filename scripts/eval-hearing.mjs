#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { HEARING_PROVIDERS } from "../src/lib/lover/hearing/config.ts";
import { hearWithGemini, hearWithQwen, hearWithSelfhost } from "../src/lib/lover/hearing/http.ts";
import { transcribeWithXai } from "../src/lib/lover/hearing/xai.ts";
import {
  binaryPr,
  cer,
  cueTokenF1,
  fieldAccuracy,
  percentile,
  selfConsistency,
} from "../src/lib/lover/hearing/metrics.ts";
import { stripCueTags } from "../src/lib/lover/hearing/schema.ts";
import { stripAltTags } from "../src/lib/lover/hearing/context.ts";
import { goldTierFor, inEvalSet } from "../src/lib/lover/hearing/gold.ts";

function arg(name, fallback = "") {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

const inputPath = arg("--in") || arg("--input") || process.argv[2];
if (!inputPath) {
  console.error(
    "usage: node --experimental-strip-types scripts/eval-hearing.mjs <export.json> [--provider xai,qwen,gemini,selfhost] [--split dev|test] [--limit N] [--out result.csv]",
  );
  process.exit(1);
}

const limit = Number(arg("--limit", "0")) || 0;
const split = arg("--split");
const providerArg = arg("--provider");
const outPath = arg("--out") || "hearing-eval.csv";
const providers = (providerArg ? providerArg.split(",") : [...HEARING_PROVIDERS]).map((p) =>
  p.trim(),
);

const exported = JSON.parse(readFileSync(resolve(inputPath), "utf8"));
let clips = Array.isArray(exported.clips) ? exported.clips : Array.isArray(exported) ? exported : [];
clips = clips.filter((c) => !c.skip);
clips = clips.filter((c) => inEvalSet(c.goldSource) || Boolean(c.goldText));
if (split) clips = clips.filter((c) => c.split === split);
if (limit > 0) clips = clips.slice(0, limit);

const rows = [];
const selfScores = [];

function clipTier(clip) {
  if (Number.isFinite(clip.goldTier) && clip.goldTier > 0) return Number(clip.goldTier);
  return goldTierFor({
    source: clip.goldSource || (clip.goldText ? "confirmed" : null),
    emotionSet: Boolean(clip.utteranceEmotion),
    hasCues: Array.isArray(clip.goldCues) && clip.goldCues.length > 0,
  });
}

for (const clip of clips) {
  const goldText = clip.goldText || "";
  const goldCues = Array.isArray(clip.goldCues) ? clip.goldCues : [];
  const goldNoise = Boolean(clip.noiseOnly);
  const goldEmotion = clip.utteranceEmotion || "";
  const goldSource = clip.goldSource || (goldText ? "confirmed" : "");
  const goldTier = clipTier(clip);
  if (clip.relabelGoldText || (clip.relabelGoldCues && clip.relabelGoldCues.length)) {
    try {
      selfScores.push(
        selfConsistency(
          {
            text: goldText,
            cues: goldCues,
            utterance_emotion: goldEmotion || "neutral",
            noise_only: goldNoise,
          },
          {
            text: clip.relabelGoldText || "",
            cues: Array.isArray(clip.relabelGoldCues) ? clip.relabelGoldCues : [],
            utterance_emotion: "neutral",
            noise_only: Boolean(clip.relabelNoiseOnly),
          },
        ),
      );
    } catch {
      /* ignore */
    }
  }

  for (const provider of providers) {
    const modes = provider === "xai" ? [false] : [false, true];
    for (const nbest of modes) {
      const started = Date.now();
      let predText = "";
      let predCues = [];
      let predNoise = false;
      let predEmotion = "";
      let hardRefusal = false;
      let latency = 0;
      let cost = 0;
      let tokensOut = 0;
      let error = "";
      try {
        if (provider === "xai") {
          const stt = await transcribeWithXai({
            audioBase64: clip.audioBase64,
            mimeType: "audio/wav",
          });
          latency = stt.latency_ms;
          if (stt.ok) predText = stt.text;
          else error = stt.error;
        } else {
          const fn =
            provider === "qwen" ? hearWithQwen : provider === "gemini" ? hearWithGemini : hearWithSelfhost;
          const outcome = await fn(clip.audioBase64, { nbest });
          latency = outcome.latency_ms ?? Date.now() - started;
          if (outcome.ok) {
            predText = outcome.result.text;
            predCues = outcome.result.cues;
            predNoise = outcome.result.noise_only;
            predEmotion = outcome.result.utterance_emotion || "";
            cost = outcome.result.cost_usd ?? 0;
            tokensOut = outcome.result.tokens_out ?? 0;
          } else {
            hardRefusal = outcome.reason === "refusal";
            error = outcome.reason;
          }
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        latency = Date.now() - started;
      }

      const decoded = stripAltTags(stripCueTags(predText));
      const softRefusal = !hardRefusal && predNoise && Boolean(goldText) && !goldNoise ? 1 : 0;
      rows.push({
        clip_id: clip.id,
        provider,
        nbest: nbest ? 1 : 0,
        decode: nbest ? "nbest" : "greedy",
        split: clip.split || "",
        category: clip.category || "",
        gold_source: goldSource,
        gold_tier: goldTier,
        cer: cer(goldText, decoded),
        cue_f1: goldTier >= 3 ? cueTokenF1(goldCues, predCues).f1 : "",
        contour_acc: goldTier >= 3 ? fieldAccuracy(goldCues, predCues, "contour") : "",
        emotion_acc: goldTier >= 2 ? (goldEmotion && goldEmotion === predEmotion ? 1 : 0) : "",
        gold_noise: goldNoise,
        pred_noise: predNoise,
        hard_refusal: hardRefusal ? 1 : 0,
        soft_refusal: softRefusal,
        refusal: hardRefusal ? 1 : 0,
        latency_ms: latency,
        tokens_out: tokensOut,
        cost_usd: cost,
        error,
      });
    }
  }
}

function mean(list, key) {
  const nums = list.map((row) => row[key]).filter((v) => v !== "" && v != null && Number.isFinite(Number(v)));
  if (!nums.length) return NaN;
  return nums.reduce((s, v) => s + Number(v), 0) / nums.length;
}

function fmt(n, digits = 3) {
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
}

function report(title, subset) {
  if (!subset.length) return;
  const noise = binaryPr(
    subset.map((r) => Boolean(r.gold_noise)),
    subset.map((r) => Boolean(r.pred_noise)),
  );
  const lat = subset.map((r) => r.latency_ms);
  const tokens = subset.map((r) => Number(r.tokens_out) || 0);
  console.log(
    [
      title,
      `n=${subset.length}`,
      `CER=${fmt(mean(subset, "cer"))}`,
      `cueF1=${fmt(mean(subset, "cue_f1"))}`,
      `emotion=${fmt(mean(subset, "emotion_acc"))}`,
      `noiseP=${noise.precision.toFixed(3)}`,
      `noiseR=${noise.recall.toFixed(3)}`,
      `hardRefusal=${fmt(mean(subset, "hard_refusal"))}`,
      `softRefusal=${fmt(mean(subset, "soft_refusal"))}`,
      `tokens_out=${fmt(mean(subset, "tokens_out"), 1)}`,
      `p50=${percentile(lat, 50).toFixed(0)}ms`,
      `p95=${percentile(lat, 95).toFixed(0)}ms`,
      `tok_p50=${percentile(tokens, 50).toFixed(0)}`,
      `tok_p95=${percentile(tokens, 95).toFixed(0)}`,
      `cost=$${fmt(mean(subset, "cost_usd"), 4)}`,
    ].join("  "),
  );
}

console.log(`clips=${clips.length} providers=${providers.join(",")} split=${split || "all"}`);

console.log("\n=== by provider × decode ===");
for (const provider of providers) {
  for (const decode of ["greedy", "nbest"]) {
    report(`${provider} ${decode}`, rows.filter((r) => r.provider === provider && r.decode === decode));
  }
}

console.log("\n=== by gold_source ===");
for (const source of ["confirmed", "edited"]) {
  report(source, rows.filter((r) => r.gold_source === source && r.decode === "greedy"));
}

console.log("\n=== by category (greedy) ===");
const categories = [...new Set(rows.map((r) => r.category || "未分类"))].sort();
for (const category of categories) {
  report(category || "未分类", rows.filter((r) => (r.category || "未分类") === (category || "未分类") && r.decode === "greedy"));
}

console.log("\n=== by gold_tier (greedy) ===");
for (const tier of [1, 2, 3]) {
  const subset = rows.filter((r) => r.gold_tier === tier && r.decode === "greedy");
  report(`tier${tier}`, subset);
}

if (selfScores.length) {
  const avg = (key) => mean(selfScores.map((s) => ({ v: s[key] })), "v");
  console.log(
    `self-consistency n=${selfScores.length} text=${avg("textAgree").toFixed(3)} tokens=${avg("tokens").toFixed(3)} contour=${avg("contour").toFixed(3)} emotion=${avg("emotion").toFixed(3)} noise=${avg("noise").toFixed(3)}`,
  );
}

const header = Object.keys(rows[0] || {
  clip_id: "",
  provider: "",
  nbest: 0,
  decode: "",
  split: "",
  category: "",
  gold_source: "",
  gold_tier: 0,
  cer: 0,
  cue_f1: 0,
  contour_acc: 0,
  emotion_acc: 0,
  gold_noise: false,
  pred_noise: false,
  hard_refusal: 0,
  soft_refusal: 0,
  refusal: 0,
  latency_ms: 0,
  tokens_out: 0,
  cost_usd: 0,
  error: "",
});
const csv = [
  header.join(","),
  ...rows.map((row) => header.map((key) => csvCell(row[key])).join(",")),
].join("\n");
writeFileSync(outPath, `${csv}\n`);
console.log(`wrote ${outPath}`);

function csvCell(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}
