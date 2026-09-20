import { createHash } from "node:crypto";
import { lastDialogueTurns, HEARING_CONTEXT_ROUNDS, type ContextTurn } from "./context.ts";
import { promptFingerprint } from "../prompt.ts";

export function gitCommitSha(): string {
  return (process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || "").slice(0, 40);
}

export function promptHash12(prompt: string): string {
  return createHash("sha256")
    .update(prompt || "")
    .digest("hex")
    .slice(0, 12);
}

export function hashQingranPrompt(systemPrompt: string): string {
  return promptHash12(promptFingerprint(systemPrompt));
}

export type { ContextTurn };

export function lastContextTurns(messages: ContextTurn[], rounds = HEARING_CONTEXT_ROUNDS): ContextTurn[] {
  return lastDialogueTurns(messages, rounds);
}