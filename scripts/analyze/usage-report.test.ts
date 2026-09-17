import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildUsageReport, parseJsonl } from "./usage-report.ts";

test("usage-report covers latency, cost, and errors from fixture", () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), "fixture.jsonl");
  const md = buildUsageReport(parseJsonl(readFileSync(file, "utf8")));
  assert.match(md, /TTFT p50/);
  assert.match(md, /stale mind/);
  assert.match(md, /dusk:timeout/);
  assert.match(md, /新增 1，替换 1/);
  assert.match(md, /reflect: 1 次/);
});
