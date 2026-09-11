import assert from "node:assert/strict";
import test from "node:test";
import { mergeExtracted, retrieveMemories, similar } from "./memory";

test("retrieve prefers open loops and soothing prefs when the user is down", () => {
  const now = Date.now();
  const memories = mergeExtracted(
    [],
    [
      { text: "林泽因为嫌吵从房子里搬了出去", kind: "event", importance: 9 },
      { text: "Rosie 不喜欢别人对她说加油", kind: "preference", importance: 8 },
      { text: "周五要答辩", kind: "open_loop", importance: 7 },
      { text: "她中午吃过一碗面", kind: "fact", importance: 3 },
    ],
    now,
  );
  const { retrieved, openLoops } = retrieveMemories(memories, "好累，好怕，不想听加油");
  assert.equal(openLoops.some((m) => m.text.includes("答辩")), true);
  assert.equal(
    retrieved.some((m) => m.text.includes("加油")) || openLoops.some((m) => m.text.includes("加油")),
    true,
  );
});

test("similar catches the same event phrased twice", () => {
  assert.equal(
    similar("林泽因为嫌清然和Rosie太吵而从房子里搬了出去", "林泽嫌太吵从房子里搬出去了"),
    true,
  );
});
