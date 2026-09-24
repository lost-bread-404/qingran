import assert from "node:assert/strict";
import { test } from "node:test";
import { openIsolatedSql } from "../eval-db.ts";
import { defaultPrompt } from "./catalog.ts";
import { defaultDoc, serializeDoc } from "./doc.ts";
import { getPromptVersion, listPrompts, loadPrompt, restorePrompt, savePrompt } from "./store.ts";

test("prompt overrides round-trip and restore to catalog default", async () => {
  const iso = await openIsolatedSql();
  try {
    const loaded = await loadPrompt("voice");
    assert.equal(loaded.custom, false);
    assert.equal(loaded.body, serializeDoc(defaultDoc("voice")));
    assert.match(loaded.body, /\{recent_phrases\}/);
    assert.match(defaultPrompt("voice"), /\{system_prompt\}/);
    const saved = await savePrompt("voice", "hello {system_prompt}");
    assert.equal(saved.custom, true);
    assert.ok(saved.hash);
    const version = await getPromptVersion(saved.hash);
    assert.equal(version, saved.body);
    const again = await loadPrompt("voice");
    assert.match(again.body, /hello \{system_prompt\}/);
    const list = await listPrompts();
    const voice = list.find((p) => p.key === "voice");
    assert.equal(voice?.custom, true);
    assert.equal(voice?.name, "每轮回复");
    assert.ok(voice?.placeholders.some((p) => p.token === "system_prompt"));
    assert.ok(voice?.placeholders.some((p) => p.token === "recent_phrases"));
    const restored = await restorePrompt("voice");
    assert.equal(restored.body, serializeDoc(defaultDoc("voice")));
    assert.equal(restored.custom, false);
  } finally {
    await iso.close();
  }
});