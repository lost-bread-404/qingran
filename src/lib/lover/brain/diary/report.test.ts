import assert from "node:assert/strict";
import { test } from "node:test";
import { narrativeNumbersOk } from "./report-check.ts";

test("narrative numbers must exist in data", () => {
  const data = { coverage: 0.4, n11: 6, lift: 2.5, days: 12 };
  assert.equal(narrativeNumbersOk("覆盖率 0.4，有 6 次，lift 2.5", data), true);
  assert.equal(narrativeNumbersOk("有 99 次", data), false);
  assert.equal(narrativeNumbersOk("没有数字也可以写感觉", data), true);
});
