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
  assert.match(defaultPrompt("portrait"), /\{system_prompt\}/);
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

test("remember overflow consolidate expose their placeholders", () => {
  assert.match(defaultPrompt("remember"), /\{memories\}/);
  assert.match(defaultPrompt("remember"), /\{stretch\}/);
  assert.match(defaultPrompt("overflow"), /\{overflow\}/);
  assert.match(defaultPrompt("consolidate"), /\{clock\}/);
});

test("reflect archive portrait defaults close the memory loop", () => {
  assert.match(defaultPrompt("reflect"), /宁可空着/);
  assert.match(defaultPrompt("reflect"), /不要延续上一刻的计划/);
  assert.match(defaultPrompt("reflect"), /必须用中文/);
  assert.match(defaultPrompt("archive"), /清然承诺/);
  assert.match(defaultPrompt("archive"), /同一承诺不重复记录/);
  assert.match(defaultPrompt("portrait"), /稳定理解/);
  assert.match(defaultPrompt("portrait"), /意思相近的主题合并/);
  assert.match(defaultPrompt("archive"), /第一人称/);
  assert.match(defaultPrompt("portrait"), /第一人称/);
  assert.match(defaultPrompt("reflect"), /只写对她的理解/);
  assert.match(defaultPrompt("reflect"), /不要再推她学习/);
  assert.match(defaultPrompt("reflect"), /第一人称/);
  const voice = PROMPT_CATALOG.find((s) => s.key === "voice");
  const voiceBody = voice?.variants[0]?.messages.map((message) => message.content).join("\n") ?? "";
  assert.match(voiceBody, /不要复述，也不要说明自己没做什么/);
  assert.match(defaultPrompt("dusk"), /第一人称/);
  assert.match(defaultPrompt("synth"), /第一人称/);
  assert.ok(voice?.placeholders.some((p) => p.token === "mind"));
});
