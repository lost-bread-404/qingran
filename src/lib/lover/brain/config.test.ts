import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MODEL_CLASSES, resolveRoute, validateModelClasses } from "./config.ts";

test("model classes pass capability checks", () => {
  assert.deepEqual(validateModelClasses(), []);
});

test("route overrides class, env route beats class", () => {
  const voice = resolveRoute("voice");
  assert.equal(voice.model, MODEL_CLASSES.REALTIME.model);
  assert.equal(voice.effort, null);
  const report = resolveRoute("report");
  assert.equal(report.effort, "medium");
  const reflect = resolveRoute("reflect");
  assert.equal(reflect.cls, "FAST_THINKER");
  assert.equal(reflect.effort, "low");
});

test("src tree has no grok- model strings outside config.ts", async () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)));
  const hits: string[] = [];
  async function walk(dir: string) {
    for (const name of await readdir(dir)) {
      const full = path.join(dir, name);
      const info = await stat(full);
      if (info.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(name)) continue;
      if (name === "config.ts" || name === "config.test.ts") continue;
      const text = await readFile(full, "utf8");
      if (/grok-/.test(text)) hits.push(path.relative(root, full));
    }
  }
  await walk(root);
  assert.deepEqual(hits, []);
});
