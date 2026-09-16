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

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const scenariosDir = join(here, "scenarios");
  const outDir = join(here, "../../out");
  mkdirSync(outDir, { recursive: true });
  const files = readdirSync(scenariosDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();

  const pack: number[] = [];
  const ttft: number[] = [];
  const qingranRows: Array<Record<string, number>> = [];
  let handed = 0;
  let judged = 0;
  const diaryLines: string[] = [];

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
  ] as const;

  const lines = [
    "# Eval report",
    "",
    `scenarios: ${files.length}`,
    "",
    "## 清然侧",
    "",
    `| 指标 | 均值 |`,
    `|---|---|`,
    ...[...binary, ...scale].map(
      (k) => `| ${k} | ${mean(qingranRows.map((r) => Number(r[k] ?? 0))).toFixed(2)} |`,
    ),
    "",
    `handed_back 比例：${judged ? (handed / judged).toFixed(2) : "n/a"}（${handed}/${judged}）`,
    "",
    "## 日记侧预埋规律 recall",
    "",
    ...(diaryLines.length ? diaryLines : ["- （没有可核对的日记 scenario）"]),
    "",
    "## 延迟",
    "",
    `| | p50 | p95 |`,
    `|---|---|---|`,
    `| pack_ms | ${pct(pack, 0.5)} | ${pct(pack, 0.95)} |`,
    `| ttft_ms | ${pct(ttft, 0.5)} | ${pct(ttft, 0.95)} |`,
    "",
  ];
  const markdown = lines.join("\n");
  writeFileSync(join(outDir, "report.md"), markdown);
  console.log(markdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
