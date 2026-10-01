import { callModel } from "./llm.ts";
import { now } from "./clock.ts";
import { listHistoryWindow } from "./store.ts";
import { parsePromptBody, renderVariant } from "./prompts/doc.ts";
import { loadPrompt } from "./prompts/store.ts";
import { getInner, INTIMATE_HOLD_MS, setIntimate } from "./heart.ts";
import { isNightNoiseBody, modelFacingText } from "../message-markup.ts";

/**
 * Whether the two of them are in an intimate scene (requirements 第 1、2 节): his intimate side is written in the
 * intimate notes, and the reply sees them only while they are already in bed. Shown always, the reply took them
 * as the task and pushed every tender moment toward sex. Judged after each reply (never before one), for the next.
 */
export const SCENE_SCHEMA = {
  name: "scene",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["intimate"] as string[],
    properties: { intimate: { type: "boolean" } },
  },
};

const SCENE_WINDOW = 6;

export async function judgeScene(turnSeq: number): Promise<void> {
  const rows = (await listHistoryWindow(null, SCENE_WINDOW + 4)).filter((m) => !isNightNoiseBody(m.text)).slice(-SCENE_WINDOW);
  if (!rows.length) return;
  const loaded = await loadPrompt("scene");
  const messages = renderVariant(parsePromptBody("scene", loaded.body), "main", {
    conversation: rows.map((m) => `${m.role === "user" ? "Rosie" : "清然"}：${modelFacingText(m.text)}`).join("\n"),
  });
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const users = messages.filter((m) => m.role !== "system").map((m) => m.content);
  const result = await callModel("scene", {
    system,
    input: users.join("\n\n"),
    inputParts: users,
    schema: SCENE_SCHEMA,
    turnSeq,
    promptKey: loaded.key,
    promptHash: loaded.hash,
    outputRef: `scene:${turnSeq}`,
  });
  if (!result.ok || !result.json) return;
  await setIntimate((result.json as { intimate?: unknown }).intimate === true, now());
}

/** For the reply: in a scene now, unless the last judgement is from before a long break. */
export async function inIntimateScene(nowMs: number): Promise<boolean> {
  const inner = await getInner();
  return inner.intimate && nowMs - inner.intimateAt < INTIMATE_HOLD_MS;
}
