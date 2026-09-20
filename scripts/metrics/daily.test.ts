import assert from "node:assert/strict";
import { test } from "node:test";
import { jaccard } from "./daily.ts";

test("jaccard is 1 for identical or empty sets, 0 for disjoint", () => {
  assert.equal(jaccard(["a", "b"], ["b", "a"]), 1);
  assert.equal(jaccard([], []), 1);
  assert.equal(jaccard(["a"], ["b"]), 0);
  assert.equal(jaccard(["a", "b"], ["b", "c"]), 1 / 3);
});
