import assert from "node:assert/strict";
import { test } from "node:test";
import { openIsolatedSql } from "../eval-db.ts";
import { defaultPrompt } from "./catalog.ts";
import { getPromptVersion, listPrompts, loadPrompt, restorePrompt, savePrompt } from "./store.ts";

test("prompt overrides round-trip and restore to catalog default", async () => {
  const iso = await openIsolatedSql();
  try {
    const loaded = await loadPrompt("voice");
    assert.equal(loaded.body, defaultPrompt("voice"));
    assert.equal(loaded.custom, false);
    const saved = await savePrompt("voice", "hello {system_prompt}");
    assert.equal(saved.custom, true);
    assert.ok(saved.hash);
    const version = await getPromptVersion(saved.hash);
    assert.equal(version, "hello {system_prompt}");
    const again = await loadPrompt("voice");
    assert.equal(again.body, "hello {system_prompt}");
    const list = await listPrompts();
    const voice = list.find((p) => p.key === "voice");
    assert.equal(voice?.custom, true);
    assert.equal(voice?.name, "每轮回复");
    assert.ok(voice?.placeholders.some((p) => p.token === "system_prompt"));
    const restored = await restorePrompt("voice");
    assert.equal(restored.body, defaultPrompt("voice"));
    assert.equal(restored.custom, false);
  } finally {
    await iso.close();
  }
});
