import assert from "node:assert/strict";
import { test } from "node:test";
import { micActionForConfirmPanel } from "./confirm-call.ts";

test("opening the confirm panel deafens an active call", () => {
  assert.equal(
    micActionForConfirmPanel({
      panelOpen: true,
      wasOpen: false,
      callActive: true,
      qingranSpeaking: false,
    }),
    "deafen",
  );
});

test("closing the confirm panel restores listen", () => {
  assert.equal(
    micActionForConfirmPanel({
      panelOpen: false,
      wasOpen: true,
      callActive: true,
      qingranSpeaking: false,
    }),
    "hear",
  );
});

test("closing while Qingran is speaking does not call hear", () => {
  assert.equal(
    micActionForConfirmPanel({
      panelOpen: false,
      wasOpen: true,
      callActive: true,
      qingranSpeaking: true,
    }),
    null,
  );
});

test("no call means no mic action", () => {
  assert.equal(
    micActionForConfirmPanel({
      panelOpen: true,
      wasOpen: false,
      callActive: false,
      qingranSpeaking: false,
    }),
    null,
  );
  assert.equal(
    micActionForConfirmPanel({
      panelOpen: false,
      wasOpen: true,
      callActive: false,
      qingranSpeaking: false,
    }),
    null,
  );
});
