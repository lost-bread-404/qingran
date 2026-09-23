import assert from "node:assert/strict";
import { test } from "node:test";
import { asQingranFirstPerson } from "./person.ts";

test("voice injection speaks as 清然: Rosie is 你, 清然 is 我, 她 is 你", () => {
  assert.equal(asQingranFirstPerson("Rosie 今天日程很满"), "你今天日程很满");
  assert.equal(asQingranFirstPerson("清然承诺陪 Rosie 写完这章"), "我承诺陪你写完这章");
  assert.equal(asQingranFirstPerson("她说过难过时想被叫小猫"), "你说过难过时想被叫小猫");
  assert.equal(asQingranFirstPerson("叫她小猫"), "叫你小猫");
  assert.equal(asQingranFirstPerson("Rosie's 日程"), "你的日程");
  assert.equal(asQingranFirstPerson("rosie 说想睡"), "你说想睡");
});

test("她们 and already-first-person text stay put", () => {
  assert.equal(asQingranFirstPerson("她们一起出门"), "她们一起出门");
  assert.equal(asQingranFirstPerson("我在医学院"), "我在医学院");
  assert.equal(asQingranFirstPerson("你今天日程很满"), "你今天日程很满");
  assert.equal(asQingranFirstPerson("林泽说他先走"), "林泽说他先走");
  assert.equal(asQingranFirstPerson(""), "");
});

test("conversion is idempotent", () => {
  const once = asQingranFirstPerson("清然答应 Rosie：她可以晚一点睡");
  assert.equal(once, "我答应你：你可以晚一点睡");
  assert.equal(asQingranFirstPerson(once), once);
});
