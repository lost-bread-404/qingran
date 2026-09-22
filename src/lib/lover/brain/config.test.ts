import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LONG_DRAIN_MS, MODEL_CLASSES, ROUTES, resolveRoute, resolveVoiceChat, validateModelClasses } from "./config.ts";

test("model classes pass capability checks", () => {
  assert.deepEqual(validateModelClasses(), []);
});

test("route overrides class, env route beats class", () => {
  const voice = resolveRoute("voice");
  assert.equal(voice.model, MODEL_CLASSES.FAST_THINKER.model);
  assert.equal(voice.effort, "low");
  assert.equal(voice.timeoutMs, 60_000);
  const report = resolveRoute("report");
  assert.equal(report.effort, "medium");
  const reflect = resolveRoute("reflect");
  assert.equal(reflect.cls, "FAST_THINKER");
  assert.equal(reflect.effort, "low");
  assert.equal(MODEL_CLASSES.FAST_THINKER.model, "grok-4.3");
});

test("voice chat picker maps to grok-4.3 or the 4.20 safety model", () => {
  const low = resolveVoiceChat("4.3-low");
  assert.equal(low.model, MODEL_CLASSES.FAST_THINKER.model);
  assert.equal(low.effort, "low");
  assert.equal(low.timeoutMs, 60_000);
  const mid = resolveVoiceChat("4.3-medium");
  assert.equal(mid.model, MODEL_CLASSES.FAST_THINKER.model);
  assert.equal(mid.effort, "medium");
  const safe = resolveVoiceChat("4.20");
  assert.equal(safe.model, MODEL_CLASSES.REALTIME.model);
  assert.equal(safe.effort, null);
  assert.deepEqual(resolveVoiceChat(), low);
  assert.deepEqual(resolveVoiceChat("nope"), low);
});

test("every route timeout fits in LONG_DRAIN_MS with 10s slack", () => {
  for (const [name, spec] of Object.entries(ROUTES)) {
    assert.ok(
      spec.timeoutMs < LONG_DRAIN_MS - 10_000,
      `${name} timeout ${spec.timeoutMs} >= LONG_DRAIN_MS - 10s`,
    );
  }
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
