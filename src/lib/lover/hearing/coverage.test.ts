import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeCoverage } from "./coverage.ts";

test("coverage splits confirmed vs edited and flags thin categories", () => {
  const en = Array.from({ length: 6 }, (_, i) => ({
    category: "en",
    mode: "call" as const,
    gold_source: i % 2 ? "edited" : "confirmed",
    storage_backend: "blob",
  }));
  const stats = summarizeCoverage(
    [
      ...en,
      { category: "codeswitch", mode: "text", gold_source: "confirmed", storage_backend: "db" },
      { category: "noise", mode: "call", gold_source: null, storage_backend: "blob" },
    ],
    20,
  );
  assert.equal(stats.confirmed, 4);
  assert.equal(stats.edited, 3);
  assert.equal(stats.labeled, 7);
  assert.equal(stats.confirmationRate, 0.35);
  assert.equal(stats.byCategory.en?.n, 6);
  assert.equal(stats.byCategory.en?.edited, 3);
  assert.equal(stats.byMode.call?.confirmed, 3);
  assert.equal(stats.dbBacked, 1);
  assert.ok(stats.thinCategories.includes("codeswitch"));
  assert.ok(!stats.thinCategories.includes("en"));
});
