import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SESSION_MAX_AGE_MS,
  parseCookie,
  signSession,
  verifySession,
} from "./session.ts";

const PW = "test-password-at-least-16";
const NOW = 1_700_000_000_000;

test("sign then verify", () => {
  const token = signSession(PW, NOW);
  assert.equal(verifySession(token, PW, NOW), true);
  assert.match(token, /^v1\.\d+\.[A-Za-z0-9_-]+$/);
});

test("tampered signature is rejected", () => {
  const token = signSession(PW, NOW);
  const bad = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
  assert.equal(verifySession(bad, PW, NOW), false);
});

test("expired token is rejected", () => {
  const token = signSession(PW, NOW);
  assert.equal(verifySession(token, PW, NOW + SESSION_MAX_AGE_MS + 1), false);
});

test("future issuedAt is rejected", () => {
  const token = signSession(PW, NOW + 10 * 60_000);
  assert.equal(verifySession(token, PW, NOW), false);
});

test("changing the password invalidates old cookies", () => {
  const token = signSession(PW, NOW);
  assert.equal(verifySession(token, "other-password-xxxxxx", NOW), false);
});

test("malformed values are rejected", () => {
  assert.equal(verifySession("", PW, NOW), false);
  assert.equal(verifySession("v1.abc.sig", PW, NOW), false);
  assert.equal(verifySession("v2.1.sig", PW, NOW), false);
  assert.equal(verifySession(null, PW, NOW), false);
  assert.equal(verifySession("v1.1.", PW, NOW), false);
});

test("parseCookie finds qr_session", () => {
  assert.equal(parseCookie("a=1; qr_session=v1.1.abc; b=2"), "v1.1.abc");
  assert.equal(parseCookie("qr_session=only"), "only");
  assert.equal(parseCookie("other=1"), null);
});
