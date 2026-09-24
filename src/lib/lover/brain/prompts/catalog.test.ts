import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultPrompt, PROMPT_CATALOG, promptKeys } from "./catalog.ts";
import { fillTemplate, templateHas } from "./fill.ts";

test("every catalog step has a name, blurb, and default", () => {
  assert.ok(promptKeys().includes("voice"));
  assert.ok(promptKeys().includes("reflect"));
  assert.ok(promptKeys().includes("archive"));
  for (const spec of PROMPT_CATALOG) {
    assert.ok(spec.name.trim());
    assert.ok(spec.blurb.trim());
    assert.ok(spec.defaultText.trim());
  }
});

test("persona lives only in {system_prompt}; hardcoded stance is gone", () => {
  for (const spec of PROMPT_CATALOG) {
    assert.doesNotMatch(spec.defaultText, /注意力在 Rosie 身上/);
    assert.doesNotMatch(spec.defaultText, /你深爱她、渴望她/);
    assert.doesNotMatch(spec.defaultText, /sadistic dom/);
  }
  assert.match(defaultPrompt("voice"), /\{system_prompt\}/);
  assert.match(defaultPrompt("reflect"), /\{system_prompt\}/);
  assert.match(defaultPrompt("editor"), /\{system_prompt\}/);
});

test("fillTemplate replaces known tokens and leaves {A|B} alone", () => {
  const out = fillTemplate("人设：{system_prompt}\n歧义 {A|B}", { system_prompt: "你就是清然。" });
  assert.equal(out, "人设：你就是清然。\n歧义 {A|B}");
  assert.equal(templateHas("{system_prompt}\n{history}", "history"), true);
  assert.equal(templateHas("{system_prompt}", "history"), false);
});

test("catalog blurbs do not name a model id", () => {
  const banned = "grok" + "-";
  for (const spec of PROMPT_CATALOG) {
    assert.equal(spec.blurb.includes(banned), false);
    assert.equal(spec.defaultText.includes(banned), false);
  }
});

test("removed memory prompts are not in the catalog", () => {
  assert.equal(promptKeys().includes("remember" as never), false);
  assert.equal(promptKeys().includes("overflow" as never), false);
  assert.equal(promptKeys().includes("consolidate" as never), false);
});

test("reflect archive editor defaults close the memory loop", () => {
  assert.match(defaultPrompt("reflect"), /有自己欲望/);
  assert.match(defaultPrompt("reflect"), /plans/);
  assert.match(defaultPrompt("reflect"), /第一人称/);
  assert.doesNotMatch(defaultPrompt("reflect"), /不要延续上一刻的计划/);
  assert.match(defaultPrompt("archive"), /清然承诺/);
  assert.match(defaultPrompt("archive"), /同一承诺不重复记录/);
  assert.match(defaultPrompt("archive"), /清然不会读/);
  assert.match(defaultPrompt("editor"), /只输出 ops/);
  assert.match(defaultPrompt("editor"), /第一人称/);
  assert.match(defaultPrompt("archive"), /第一人称/);
  assert.match(defaultPrompt("reflect"), /所有"不……"都写在这里/);
  const voice = PROMPT_CATALOG.find((s) => s.key === "voice");
  const voiceBody = voice?.variants[0]?.messages.map((message) => message.content).join("\n") ?? "";
  assert.match(voiceBody, /【我此刻】/);
  assert.match(voiceBody, /【我记得的】/);
  assert.doesNotMatch(voiceBody, /不要复述/);
  assert.match(defaultPrompt("dusk"), /第一人称/);
  assert.match(defaultPrompt("synth"), /第一人称/);
  assert.ok(voice?.placeholders.some((p) => p.token === "feel"));
  assert.ok(voice?.placeholders.some((p) => p.token === "dossier"));
  assert.equal(voice?.placeholders.some((p) => p.token === "mind"), false);
});
