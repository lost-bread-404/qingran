import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyRequest, isPublicPath, safeNext } from "./classify.ts";

test("whitelist: login, cron, static assets", () => {
  assert.equal(isPublicPath("GET", "/login"), true);
  assert.equal(isPublicPath("GET", "/login?error=1"), true);
  assert.equal(isPublicPath("POST", "/api/login"), true);
  assert.equal(isPublicPath("POST", "/api/logout"), true);
  assert.equal(isPublicPath("GET", "/api/cron/brain"), true);
  assert.equal(isPublicPath("GET", "/api/cron/brain?slot=2"), true);
  assert.equal(isPublicPath("GET", "/assets/index-abc.js"), true);
  assert.equal(isPublicPath("GET", "/favicon.svg"), true);
  assert.equal(isPublicPath("GET", "/favicon.ico"), true);
  assert.equal(isPublicPath("GET", "/apple-touch-icon.png"), true);
  assert.equal(isPublicPath("GET", "/__grok/manifest.webmanifest"), true);
  assert.equal(isPublicPath("GET", "/__grok/icon-180.png"), true);
  assert.equal(isPublicPath("GET", "/__grok/install/styles.css"), true);
  assert.equal(isPublicPath("GET", "/og.jpg"), true);
  assert.equal(isPublicPath("GET", "/icons/foo.png"), true);
  assert.equal(isPublicPath("GET", "/__grok/secret"), false);
  assert.equal(isPublicPath("GET", "/__grok/anything.js"), false);
});

test("protected paths are not public", () => {
  assert.equal(isPublicPath("GET", "/"), false);
  assert.equal(isPublicPath("GET", "/diary"), false);
  assert.equal(isPublicPath("POST", "/api/talk"), false);
  assert.equal(isPublicPath("GET", "/api/warm"), false);
  assert.equal(isPublicPath("POST", "/_serverFn/abc"), false);
  assert.equal(isPublicPath("GET", "/login.js"), false);
  assert.equal(isPublicPath("POST", "/login"), false);
});

test("classifyRequest: cookie / html / api", () => {
  assert.equal(classifyRequest("GET", "/", "text/html", true), "next");
  assert.equal(classifyRequest("GET", "/", "text/html", false), "redirect");
  assert.equal(classifyRequest("GET", "/diary", "text/html,application/xhtml+xml", false), "redirect");
  assert.equal(classifyRequest("POST", "/api/talk", "application/json", false), "unauthorized");
  assert.equal(classifyRequest("GET", "/api/warm", "*/*", false), "unauthorized");
  assert.equal(classifyRequest("POST", "/_serverFn/x", "application/json", false), "unauthorized");
  assert.equal(classifyRequest("GET", "/login", "text/html", false), "next");
  assert.equal(classifyRequest("POST", "/api/login", "application/x-www-form-urlencoded", false), "next");
  assert.equal(classifyRequest("GET", "/api/cron/brain", "*/*", false), "next");
});

test("safeNext blocks open redirects", () => {
  assert.equal(safeNext("/diary"), "/diary");
  assert.equal(safeNext("/diary?x=1"), "/diary?x=1");
  assert.equal(safeNext("/"), "/");
  assert.equal(safeNext(null), "/");
  assert.equal(safeNext(""), "/");
  assert.equal(safeNext("//evil.com"), "/");
  assert.equal(safeNext("//evil.com/phish"), "/");
  assert.equal(safeNext("https://evil.com"), "/");
  assert.equal(safeNext("/\\evil.com"), "/");
  assert.equal(safeNext("https:%2f%2fevil.com"), "/");
  assert.equal(safeNext("diary"), "/");
});
