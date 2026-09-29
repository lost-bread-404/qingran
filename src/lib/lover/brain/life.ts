/** Proactive messages: a soft daily cap (requirements 第 5 节), and one retry after a failed call. */
export const REACH_LLM_DAY_MAX = 48;
export const REACH_SENT_DAY_MAX = 30;
export const REACH_RETRY_MS = 15 * 60 * 1000;

/** His identity (kept apart from the persona), as the line models see. */
export function identityBlock(identity: string): string {
  const text = identity.trim();
  return text ? `【我的身份】\n${text}` : "";
}
