import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addManualMemory,
  fromDatetimeLocal,
  resolveManualMemory,
  sortMemoriesByTime,
  splitLeadingTimestamp,
  toDatetimeLocal,
} from "./memory.ts";

test("splitLeadingTimestamp reads 2026/8/31 glued to the fact", () => {
  const raw =
    "2026/8/31清然坦白匹配系统在来纽约前就将Rosie定为完美omega并提供攻略资料，他据此接近并强制标记她，一开始带目的，现分不清系统与真心，承诺以后多情感交流。";
  const parsed = splitLeadingTimestamp(raw);
  assert.ok(parsed.at);
  const d = new Date(parsed.at!);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 7);
  assert.equal(d.getDate(), 31);
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
  assert.match(parsed.text, /^清然坦白/);
  assert.doesNotMatch(parsed.text, /2026/);
});

test("splitLeadingTimestamp keeps time of day when present", () => {
  const parsed = splitLeadingTimestamp("2026-08-31 14:30 清然搬家");
  assert.ok(parsed.at);
  const d = new Date(parsed.at!);
  assert.equal(d.getHours(), 14);
  assert.equal(d.getMinutes(), 30);
  assert.equal(parsed.text, "清然搬家");
});

test("splitLeadingTimestamp understands 年月日", () => {
  const parsed = splitLeadingTimestamp("2025年12月1日，Rosie提分手");
  assert.ok(parsed.at);
  const d = new Date(parsed.at!);
  assert.equal(d.getFullYear(), 2025);
  assert.equal(d.getMonth(), 11);
  assert.equal(d.getDate(), 1);
  assert.equal(parsed.text, "Rosie提分手");
});

test("splitLeadingTimestamp leaves ordinary facts alone", () => {
  const parsed = splitLeadingTimestamp("清然和Rosie开始同居");
  assert.equal(parsed.at, null);
  assert.equal(parsed.text, "清然和Rosie开始同居");
});

test("resolveManualMemory uses now unless the time was edited or a leading date exists", () => {
  const now = Date.parse("2026-09-12T13:35:00");
  const plain = resolveManualMemory("清然找到工作", toDatetimeLocal(now), false, now);
  assert.equal(plain.at, now);
  assert.equal(plain.text, "清然找到工作");

  const dated = resolveManualMemory(
    "2026/8/31清然坦白匹配系统",
    toDatetimeLocal(now),
    false,
    now,
  );
  const d = new Date(dated.at);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 7);
  assert.equal(d.getDate(), 31);
  assert.equal(dated.text, "清然坦白匹配系统");

  const edited = resolveManualMemory(
    "2026/8/31清然坦白匹配系统",
    "2026-01-02T08:15",
    true,
    now,
  );
  assert.equal(edited.at, fromDatetimeLocal("2026-01-02T08:15"));
  assert.equal(edited.text, "清然坦白匹配系统");
});

test("addManualMemory keeps a chosen time and a long fact", () => {
  const at = new Date(2026, 7, 31).getTime();
  const text =
    "清然坦白匹配系统在来纽约前就将Rosie定为完美omega并提供攻略资料，他据此接近并强制标记她，一开始带目的，现分不清系统与真心，承诺以后多情感交流。";
  const next = addManualMemory([], text, at);
  assert.equal(next.length, 1);
  assert.equal(next[0]?.createdAt, at);
  assert.equal(next[0]?.text, text);
});

test("sortMemoriesByTime is chronological, newest first when asked", () => {
  const a = { id: "a", text: "old", createdAt: 100, updatedAt: 1 };
  const b = { id: "b", text: "new", createdAt: 300, updatedAt: 1 };
  const c = { id: "c", text: "mid", createdAt: 200, updatedAt: 1 };
  assert.deepEqual(
    sortMemoriesByTime([b, a, c]).map((m) => m.id),
    ["a", "c", "b"],
  );
  assert.deepEqual(
    sortMemoriesByTime([a, b, c], true).map((m) => m.id),
    ["b", "c", "a"],
  );
});
