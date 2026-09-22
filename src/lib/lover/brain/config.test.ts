import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  LONG_DRAIN_MS,
  MODEL_CLASSES,
  ROUTES,
  UNKNOWN_VOICE_MODEL_BLURB,
  VOICE_MODEL_BLURBS,
  isVoiceChatModelId,
  listVoiceCatalog,
  resetVoiceCatalogForTests,
  resolveRoute,
  resolveVoiceChat,
  validateModelClasses,
  voiceModelBlurb,
  voiceSafetyPick,
  voiceSupportsUiEffort,
} from "./config.ts";

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

test("voice chat picker maps model + effort, keeping legacy ids", () => {
  const low = resolveVoiceChat("4.3-low");
  assert.equal(low.model, MODEL_CLASSES.FAST_THINKER.model);
  assert.equal(low.effort, "low");
  assert.equal(low.timeoutMs, 60_000);
  const mid = resolveVoiceChat("4.3-medium");
  assert.equal(mid.model, MODEL_CLASSES.FAST_THINKER.model);
  assert.equal(mid.effort, "medium");
  assert.equal(mid.timeoutMs, 90_000);
  const safe = resolveVoiceChat("4.20");
  assert.equal(safe.model, MODEL_CLASSES.REALTIME.model);
  assert.equal(safe.effort, null);
  assert.equal(safe.timeoutMs, 28_000);
  assert.deepEqual(voiceSafetyPick(), safe);
  const current = resolveVoiceChat();
  assert.equal(current.model, MODEL_CLASSES.FAST_THINKER.model);
  assert.equal(current.effort, "low");
  const named = resolveVoiceChat("grok-4.3", "medium");
  assert.equal(named.model, "grok-4.3");
  assert.equal(named.effort, "medium");
  assert.equal(named.timeoutMs, 90_000);
  const clamped = resolveVoiceChat("grok-4.20-0309-non-reasoning", "high");
  assert.equal(clamped.model, "grok-4.20-0309-non-reasoning");
  assert.equal(clamped.effort, null);
  assert.equal(clamped.timeoutMs, 28_000);
  const flagship = resolveVoiceChat("grok-4.5", "high");
  assert.equal(flagship.timeoutMs, 120_000);
  const unknown = resolveVoiceChat("nope");
  assert.equal(unknown.model, "nope");
  assert.equal(unknown.effort, "low");
});

test("known voice model blurbs stay in the mapping table", () => {
  assert.equal(VOICE_MODEL_BLURBS["grok-4.20-0309-non-reasoning"], "不思考、首字最快、便宜；理解最浅");
  assert.equal(VOICE_MODEL_BLURBS["grok-4.20-0309-reasoning"], "同价，先想再答；上一代");
  assert.equal(VOICE_MODEL_BLURBS["grok-4.3"], "同价，思考强度可调；Reflector 在用");
  assert.equal(VOICE_MODEL_BLURBS["grok-4.5"], "更聪明，价格约 1.6–2.4 倍，默认思考强度高、较慢");
  assert.equal(VOICE_MODEL_BLURBS["grok-4.6"], "官方称最聪明也最快，价格同 4.5");
  assert.equal(VOICE_MODEL_BLURBS["grok-4.7"], "最新旗舰，价格同 4.5");
  assert.equal(voiceModelBlurb("mystery-chat"), UNKNOWN_VOICE_MODEL_BLURB);
  assert.equal(voiceSupportsUiEffort("grok-4.3"), true);
  assert.equal(voiceSupportsUiEffort("grok-4.20-0309-non-reasoning"), false);
  assert.equal(isVoiceChatModelId("grok-4.3"), true);
  assert.equal(isVoiceChatModelId("grok-build"), false);
  assert.equal(isVoiceChatModelId("grok-imagine-image"), false);
  assert.equal(isVoiceChatModelId("grok-voice"), false);
});

test("listVoiceCatalog caches 1h and keeps only chat models", async () => {
  resetVoiceCatalogForTests();
  let n = 0;
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    n += 1;
    return new Response(
      JSON.stringify({
        data: [
          { id: "grok-4.3", completion_text_token_price: 1 },
          { id: "grok-4.7", completion_text_token_price: 2 },
          { id: "grok-build", completion_text_token_price: 1 },
          { id: "imagine-fun", completion_text_token_price: 1 },
          { id: "grok-voice-en", completion_text_token_price: 1 },
          { id: "pic-only", image_price: 9 },
          { id: "mystery-chat", completion_text_token_price: 3 },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const first = await listVoiceCatalog("key");
    const second = await listVoiceCatalog("key");
    assert.equal(n, 1);
    assert.deepEqual(first, second);
    const ids = first.map((m) => m.id);
    assert.ok(ids.includes("grok-4.3"));
    assert.ok(ids.includes("grok-4.7"));
    assert.ok(ids.includes("mystery-chat"));
    assert.ok(!ids.some((id) => /build|imagine|voice|pic-only/.test(id)));
    assert.equal(first.find((m) => m.id === "grok-4.3")?.blurb, VOICE_MODEL_BLURBS["grok-4.3"]);
    assert.equal(first.find((m) => m.id === "mystery-chat")?.blurb, UNKNOWN_VOICE_MODEL_BLURB);
    assert.equal(first.find((m) => m.id === "mystery-chat")?.supportsEffort, true);
  } finally {
    globalThis.fetch = real;
    resetVoiceCatalogForTests();
  }
});

test("listVoiceCatalog falls back to known blurbs without a key", async () => {
  resetVoiceCatalogForTests();
  const models = await listVoiceCatalog();
  assert.deepEqual(
    models.map((m) => m.id).sort(),
    Object.keys(VOICE_MODEL_BLURBS).sort(),
  );
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
