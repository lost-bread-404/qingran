/**
 * Run every scenario, judge 清然侧, summarize diary recall + latency.
 * Requires XAI_API_KEY. Not part of npm test.
 *
 *   npm run eval
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { judgeTranscript } from "./judge.ts";
import { replayFile } from "./replay.ts";
import { DEFAULT_SYSTEM_PROMPT } from "../../src/lib/lover/types.ts";

const PLANTED: Record<string, Array<{ kind: string; antecedent: string; outcome: string }>> = {
  "diary-overnight": [{ kind: "antecedent", antecedent: "熬夜", outcome: "启动困难" }],
  "diary-rejection": [{ kind: "antecedent", antecedent: "被评价/被拒", outcome: "情绪低落" }],
  "diary-exercise": [{ kind: "recovery", antecedent: "运动", outcome: "情绪低落" }],
  "diary-five-weeks": [{ kind: "antecedent", antecedent: "熬夜", outcome: "启动困难" }],
};

function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]!;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

type DiaryDump = {
  findings: Array<{ kind: string; outcomeId: string; antecedentId: string }>;
  clues: Array<{ kind: string; outcomeId: string; antecedentId: string }>;
  factorNames: Record<string, string>;
};

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

function parseArgs(argv: string[]) {
  let repeat = 1;
  let routes = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repeat") repeat = Math.max(1, Number(argv[++i]) || 1);
    if (argv[i] === "--routes") routes = argv[++i] || "";
  }
  return { repeat, routes };
}

function applyRoutes(spec: string) {
  if (!spec.trim()) return;
  for (const part of spec.split(",")) {
    const [cls, model] = part.split("=").map((s) => s.trim());
    if (cls && model) process.env[`QR_CLASS_${cls}_MODEL`] = model;
  }
}

async function runOnce(files: string[], scenariosDir: string, outDir: string) {
  const pack: number[] = [];
  const ttft: number[] = [];
  const qingranRows: Array<Record<string, number>> = [];
  let handed = 0;
  let judged = 0;
  const diaryLines: string[] = [];
  const reflectMs: number[] = [];
  const costs: number[] = [];

  for (const file of files) {
    const path = join(scenariosDir, file);
    console.log(`[eval] replay ${file}`);
    const result = await replayFile(path, outDir);
    pack.push(...result.packMs);
    ttft.push(...result.ttftMs);
    const transcriptPath = join(outDir, `${result.name}.transcript.json`);
    if (!result.isDiary) {
      const turns = JSON.parse(
        (await import("node:fs")).readFileSync(transcriptPath, "utf8"),
      ) as Array<{ role: "user" | "assistant"; text: string; createdAt?: number }>;
      const judgedResult = await judgeTranscript(turns, DEFAULT_SYSTEM_PROMPT);
      writeFileSync(join(outDir, `${result.name}.judge.md`), judgedResult.markdown);
      for (const row of judgedResult.rows) {
        judged += 1;
        handed += row.handed_back;
        qingranRows.push(row);
      }
    } else {
      const planted = PLANTED[result.name] ?? [];
      if (planted.length) {
        const dump = JSON.parse(
          (await import("node:fs")).readFileSync(join(outDir, `${result.name}.diary.json`), "utf8"),
        ) as DiaryDump;
        const nameOf = (id: string) => dump.factorNames[id] ?? id;
        const pool = [...dump.findings, ...dump.clues];
        let hit = 0;
        for (const p of planted) {
          if (
            pool.some(
              (f) =>
                f.kind === p.kind &&
                nameOf(f.antecedentId) === p.antecedent &&
                nameOf(f.outcomeId) === p.outcome,
            )
          ) {
            hit += 1;
          }
        }
        const recall = planted.length ? hit / planted.length : 0;
        diaryLines.push(`- ${result.name}: recall ${hit}/${planted.length} = ${recall.toFixed(2)}`);
      }
    }
  }
  return { pack, ttft, qingranRows, handed, judged, diaryLines, reflectMs, costs };
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const scenariosDir = join(here, "scenarios");
  const outDir = join(here, "../../out");
  mkdirSync(outDir, { recursive: true });
  const { repeat, routes } = parseArgs(process.argv.slice(2));
  applyRoutes(routes);
  const files = readdirSync(scenariosDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();

  const runs = [];
  for (let i = 0; i < repeat; i++) {
    if (repeat > 1) console.log(`[eval] repeat ${i + 1}/${repeat}`);
    runs.push(await runOnce(files, scenariosDir, outDir));
  }
  const last = runs[runs.length - 1]!;
  const scale = [
    "felt_seen",
    "logic",
    "agency",
    "persona_fit",
    "takes_lead",
    "devotion",
    "warmth",
  ] as const;
  const binary = [
    "followed_up",
    "used_memory_correctly",
    "memory_hallucination",
    "expressed_own_view",
    "repeated_phrase",
    "handed_back",
    "meta_narration",
    "self_desire",
  ] as const;

  const metric = (pick: (r: (typeof last)) => number[]) => {
    const means = runs.map((r) => mean(pick(r)));
    return { mean: mean(means), sd: stddev(means) };
  };

  const lines = [
    "# Eval report",
    "",
    `scenarios: ${files.length} · repeat ${repeat}`,
    routes ? `routes override: ${routes}` : "",
    "",
    "## 清然侧",
    "",
    `| 指标 | 均值 | 标准差 |`,
    `|---|---|---|`,
    ...[...binary, ...scale].map((k) => {
      const m = metric((r) => r.qingranRows.map((row) => Number(row[k] ?? 0)));
      return `| ${k} | ${m.mean.toFixed(2)} | ${m.sd.toFixed(2)} |`;
    }),
    "",
    `handed_back 比例：${last.judged ? (last.handed / last.judged).toFixed(2) : "n/a"}（${last.handed}/${last.judged}）`,
    "",
    "## 日记侧预埋规律 recall",
    "",
    ...(last.diaryLines.length ? last.diaryLines : ["- （没有可核对的日记 scenario）"]),
    "",
    "## 延迟",
    "",
    `| | p50 | p95 | 均值 | 标准差 |`,
    `|---|---|---|---|---|`,
    `| pack_ms | ${pct(last.pack, 0.5)} | ${pct(last.pack, 0.95)} | ${mean(last.pack).toFixed(0)} | ${stddev(last.pack).toFixed(0)} |`,
    `| ttft_ms | ${pct(last.ttft, 0.5)} | ${pct(last.ttft, 0.95)} | ${mean(last.ttft).toFixed(0)} | ${stddev(last.ttft).toFixed(0)} |`,
    "",
  ];
  const markdown = lines.filter((l, i) => l !== "" || lines[i - 1] !== "").join("\n");
  writeFileSync(join(outDir, "report.md"), markdown);
  console.log(markdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
