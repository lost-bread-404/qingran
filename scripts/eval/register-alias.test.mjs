import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("replay --help loads with the alias hook and does not call the API", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const r = spawnSync(
    process.execPath,
    [
      "--import",
      "./scripts/eval/register-alias.mjs",
      "--experimental-strip-types",
      "scripts/eval/replay.ts",
      "--help",
    ],
    { cwd: root, encoding: "utf8", env: { ...process.env, XAI_API_KEY: "" } },
  );
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /usage: replay.ts/);
});
