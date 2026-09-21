import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("Neon does not apply migrations at runtime", () => {
  const src = readFileSync(new URL("./db.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /async function applyNeonMigrations/);
  assert.doesNotMatch(src, /pg_advisory_xact_lock/);
  assert.match(src, /Neon.*no-op/);
});

test("Vercel build without DATABASE_URL skips; Neon is not a runtime fallback", () => {
  const src = readFileSync(new URL("../../scripts/migrate.mjs", import.meta.url), "utf8");
  assert.match(src, /DATABASE_URL not set — skipping/);
  assert.doesNotMatch(src, /will apply pending migrations on the first Neon query/);
  assert.doesNotMatch(src, /process\.env\.VERCEL/);
});
