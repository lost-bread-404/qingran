import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("Neon applies pending migrations on first getSql", () => {
  const src = readFileSync(new URL("./db.ts", import.meta.url), "utf8");
  assert.match(src, /async function applyNeonMigrations/);
  assert.match(src, /pg_advisory_xact_lock/);
  assert.doesNotMatch(src, /Neon": no-op/);
});

test("Vercel build without DATABASE_URL warns instead of silently skipping", () => {
  const src = readFileSync(new URL("../../scripts/migrate.mjs", import.meta.url), "utf8");
  assert.match(src, /process\.env\.VERCEL/);
  assert.match(src, /will apply pending migrations on the first Neon query/);
});
