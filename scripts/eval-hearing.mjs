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
if (split) clips = clips.filter((c) => c.split === split);
if (limit > 0) clips = clips.slice(0, limit);

const rows = [];
const selfScores = [];

for (const clip of clips) {
  const goldText = clip.goldText || "";
  const goldCues = Array.isArray(clip.goldCues) ? clip.goldCues : [];
  const goldNoise = Boolean(clip.noiseOnly);
  if (clip.relabelGoldText || (clip.relabelGoldCues && clip.relabelGoldCues.length)) {
    try {
      selfScores.push(
        selfConsistency(
          {
            text: goldText,
            cues: goldCues,
            utterance_emotion: "neutral",
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
    const started = Date.now();
    let predText = "";
    let predCues = [];
    let predNoise = false;
    let refusal = false;
    let latency = 0;
    let cost = 0;
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
        const outcome = await fn(clip.audioBase64);
        latency = outcome.latency_ms ?? Date.now() - started;
        if (outcome.ok) {
          predText = outcome.result.text;
          predCues = outcome.result.cues;
          predNoise = outcome.result.noise_only;
          cost = outcome.result.cost_usd ?? 0;
        } else {
          refusal = outcome.reason === "refusal";
          error = outcome.reason;
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      latency = Date.now() - started;
    }

    rows.push({
      clip_id: clip.id,
      provider,
      split: clip.split || "",
      category: clip.category || "",
      cer: cer(goldText, stripCueTags(predText)),
      cue_f1: cueTokenF1(goldCues, predCues).f1,
      contour_acc: fieldAccuracy(goldCues, predCues, "contour"),
      emotion_acc: fieldAccuracy(goldCues, predCues, "emotion"),
      gold_noise: goldNoise,
      pred_noise: predNoise,
      refusal: refusal ? 1 : 0,
      latency_ms: latency,
      cost_usd: cost,
      error,
    });
  }
}

function mean(list, key) {
  if (!list.length) return 0;
  return list.reduce((s, row) => s + Number(row[key] || 0), 0) / list.length;
}

console.log(`clips=${clips.length} providers=${providers.join(",")} split=${split || "all"}`);
for (const provider of providers) {
  const subset = rows.filter((r) => r.provider === provider);
  const noise = binaryPr(
    subset.map((r) => Boolean(r.gold_noise)),
    subset.map((r) => Boolean(r.pred_noise)),
  );
  const lat = subset.map((r) => r.latency_ms);
  console.log(
    [
      provider,
      `CER=${mean(subset, "cer").toFixed(3)}`,
      `cueF1=${mean(subset, "cue_f1").toFixed(3)}`,
      `contour=${mean(subset, "contour_acc").toFixed(3)}`,
      `emotion=${mean(subset, "emotion_acc").toFixed(3)}`,
      `noiseP=${noise.precision.toFixed(3)}`,
      `noiseR=${noise.recall.toFixed(3)}`,
      `refusal=${mean(subset, "refusal").toFixed(3)}`,
      `p50=${percentile(lat, 50).toFixed(0)}ms`,
      `p95=${percentile(lat, 95).toFixed(0)}ms`,
      `cost=$${mean(subset, "cost_usd").toFixed(4)}`,
    ].join("  "),
  );
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
  split: "",
  category: "",
  cer: 0,
  cue_f1: 0,
  contour_acc: 0,
  emotion_acc: 0,
  gold_noise: false,
  pred_noise: false,
  refusal: 0,
  latency_ms: 0,
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
