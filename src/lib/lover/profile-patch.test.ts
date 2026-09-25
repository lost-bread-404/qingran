import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { writeIdentity } from "./brain/life-store.ts";
import { openIsolatedSql } from "./brain/eval-db.ts";
import {
  applyProfilePatch,
  listProfileVersions,
  readProfileSnapshot,
  restoreProfileVersion,
} from "./profile-patch.ts";

test("two clients can save different fields without overwriting each other", async () => {
  const iso = await openIsolatedSql();
  try {
    const persona = await applyProfilePatch({
      patch: { systemPrompt: "人设甲", muted: true },
      baseRevs: { systemPrompt: 0 },
      source: "web client-a",
    });
    assert.equal(persona.ok, true);
    if (!persona.ok) return;
    const speed = await applyProfilePatch({
      patch: { voiceSpeed: 1.25 },
      source: "ios client-b",
    });
    assert.equal(speed.ok, true);
    const notes = await applyProfilePatch({
      patch: { intimateNotes: "亲密乙" },
      baseRevs: { intimateNotes: 0 },
      source: "web client-a",
    });
    assert.equal(notes.ok, true);
    await writeIdentity("科研年的研究生");
    const snap = await readProfileSnapshot();
    assert.equal(snap.profile.systemPrompt, "人设甲");
    assert.equal(snap.profile.intimateNotes, "亲密乙");
    assert.equal(snap.profile.voiceSpeed, 1.25);
    assert.equal(snap.profile.muted, true);
    assert.equal(snap.profile.identity, "科研年的研究生");
    assert.equal(snap.revs.systemPrompt, 1);
    assert.equal(snap.revs.intimateNotes, 1);
    assert.equal(snap.revs.identity, 1);
  } finally {
    await iso.close();
  }
});

test("saving long text with an old version is rejected and the previous text stays", async () => {
  const iso = await openIsolatedSql();
  try {
    const first = await applyProfilePatch({
      patch: { systemPrompt: "新的人设", identity: "新身份" },
      baseRevs: { systemPrompt: 0, identity: 0 },
      source: "web client-a",
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const stalePersona = await applyProfilePatch({
      patch: { systemPrompt: "旧客户端的人设" },
      baseRevs: { systemPrompt: 0 },
      source: "ios client-b",
    });
    assert.equal(stalePersona.ok, false);
    if (stalePersona.ok) return;
    assert.equal(stalePersona.conflict, true);
    assert.equal(stalePersona.field, "systemPrompt");
    assert.equal(stalePersona.latest, "新的人设");
    const staleIdentity = await applyProfilePatch({
      patch: { identity: "旧身份" },
      baseRevs: { identity: 0 },
      source: "ios client-b",
    });
    assert.equal(staleIdentity.ok, false);
    if (staleIdentity.ok) return;
    assert.equal(staleIdentity.field, "identity");
    assert.equal(staleIdentity.latest, "新身份");
    const kept = await readProfileSnapshot();
    assert.equal(kept.profile.systemPrompt, "新的人设");
    assert.equal(kept.profile.identity, "新身份");

    const saved = await applyProfilePatch({
      patch: { systemPrompt: "她决定留下的" },
      baseRevs: { systemPrompt: stalePersona.revs.systemPrompt },
      source: "ios client-b",
    });
    assert.equal(saved.ok, true);
    const rows = await listProfileVersions("systemPrompt");
    assert.equal(rows[0]?.value, "她决定留下的");
    assert.match(rows[0]?.source ?? "", /client-b/);
    const older = rows.find((row) => row.value === "新的人设");
    assert.ok(older);
    const restored = await restoreProfileVersion(older.id, "web client-a");
    assert.equal(restored?.ok, true);
    const after = await readProfileSnapshot();
    assert.equal(after.profile.systemPrompt, "新的人设");
    assert.equal(after.profile.identity, "新身份");
  } finally {
    await iso.close();
  }
});

test("clients no longer post a whole profile", () => {
  const room = readFileSync(new URL("../../components/lover/voice-room.tsx", import.meta.url), "utf8");
  const settings = readFileSync(new URL("../../components/lover/settings-drawer.tsx", import.meta.url), "utf8");
  const history = readFileSync(new URL("../../components/lover/profile-history.tsx", import.meta.url), "utf8");
  const patch = readFileSync(new URL("./profile-patch.ts", import.meta.url), "utf8");
  const server = readFileSync(new URL("./room.ts", import.meta.url), "utf8");
  assert.doesNotMatch(room, /saveRoomProfile/);
  assert.match(room, /saveProfilePatch/);
  assert.match(room, /visibilitychange/);
  assert.doesNotMatch(settings, /\.\.\.profile/);
  assert.match(settings, /persistRef\.current\(\{ systemPrompt: next \}\)/);
  assert.match(settings, /saveProfilePatch/);
  assert.match(settings, /改动记录/);
  assert.match(history, /这段在别处被改过，已为你加载最新内容/);
  assert.doesNotMatch(server, /saveRoomProfile/);
  assert.match(patch, /coalesce\(qingran_profile\.data, '\{\}'::jsonb\) \|\| \$1::jsonb/);
});
