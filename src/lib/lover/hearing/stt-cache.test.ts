import assert from "node:assert/strict";
import { test } from "node:test";
import {
  STT_CACHE_TTL_MS,
  hotPathHearingStt,
  peekHearingSttCache,
  refreshHearingSttCache,
  resetHearingSttCacheForTests,
  seedHearingSttCacheForTests,
} from "./stt-cache.ts";
import type { Sql } from "./persist.ts";

test("hot path uses last cache (or empty) and never waits on a miss", () => {
  resetHearingSttCacheForTests();
  const miss = hotPathHearingStt(["林泽"]);
  assert.deepEqual(miss.keyterms, ["林泽"]);
  assert.deepEqual(miss.rules, []);
  assert.equal(miss.needsRefresh, true);

  seedHearingSttCacheForTests({
    keyterms: ["清然", "小猫"],
    rules: [
      {
        id: "姐→姐姐",
        wrong: "姐",
        correct: "姐姐",
        count: 4,
        examples: [],
        enabled: true,
      },
    ],
    fetchedAt: Date.now(),
  });
  const hit = hotPathHearingStt(["Rosie"]);
  assert.deepEqual(hit.keyterms, ["清然", "小猫", "Rosie"]);
  assert.equal(hit.rules[0]?.correct, "姐姐");
  assert.equal(hit.needsRefresh, false);
  assert.equal(STT_CACHE_TTL_MS, 10 * 60 * 1000);
});

test("stale cache still feeds STT while marking needsRefresh", () => {
  resetHearingSttCacheForTests();
  seedHearingSttCacheForTests({
    keyterms: ["Hopkins"],
    rules: [],
    fetchedAt: Date.now() - STT_CACHE_TTL_MS - 1,
  });
  const stale = hotPathHearingStt();
  assert.deepEqual(stale.keyterms, ["Hopkins"]);
  assert.equal(stale.needsRefresh, true);
  assert.equal(stale.stale, true);
});

test("refreshHearingSttCache stores lexicon + confusion corrections without rebuild", async () => {
  resetHearingSttCacheForTests();
  const queries: string[] = [];
  const sql = ((strings: TemplateStringsArray) => {
    queries.push(strings.join("?"));
    if (strings.join("?").includes("qingran_personal_lexicon") && strings.join("?").includes("word")) {
      return Promise.resolve([{ term: "清然" }]);
    }
    if (strings.join("?").includes("qingran_personal_lexicon")) {
      return Promise.resolve([{ term: "我想你了" }]);
    }
    return Promise.resolve([]);
  }) as unknown as Sql;
  sql.query = async <T = Record<string, unknown>>(text: string) => {
    queries.push(text);
    if (text.includes("qingran_hearing_confusions")) {
      return [
        {
          id: "姐→姐姐",
          wrong: "姐",
          correct: "姐姐",
          count: 3,
          examples: [],
          enabled: true,
        },
      ] as T[];
    }
    return [] as T[];
  };

  const snap = await refreshHearingSttCache(sql);
  assert.ok(snap.keyterms.includes("姐姐"));
  assert.ok(snap.keyterms.includes("清然"));
  assert.ok(snap.keyterms.includes("我想你了"));
  assert.equal(snap.rules[0]?.wrong, "姐");
  assert.equal(peekHearingSttCache()?.fetchedAt, snap.fetchedAt);
  assert.equal(
    queries.some((q) => q.includes("qingran_messages")),
    false,
    "refresh must not rebuild lexicon from messages",
  );
  assert.equal(
    queries.some((q) => q.includes("delete from qingran_personal_lexicon")),
    false,
  );
});
