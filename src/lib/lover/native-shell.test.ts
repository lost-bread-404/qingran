import assert from "node:assert/strict";
import { test } from "node:test";
import { isNativeShell } from "./native-shell.ts";

test("web has no native shell", () => {
  assert.equal(isNativeShell(), false);
});
