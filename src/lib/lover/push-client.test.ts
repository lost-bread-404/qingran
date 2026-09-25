import assert from "node:assert/strict";
import { test } from "node:test";
import { pushTokenFromEvent } from "./push-client.ts";

test("native push token event is hex and names the env", () => {
  assert.equal(pushTokenFromEvent(null), null);
  assert.equal(pushTokenFromEvent({ token: "zzzz", env: "sandbox" }), null);
  const token = "ab".repeat(32);
  assert.deepEqual(pushTokenFromEvent({ token: token.toUpperCase(), env: "production" }), {
    token,
    env: "production",
  });
  assert.equal(pushTokenFromEvent({ token, env: "nope" })?.env, "sandbox");
});
