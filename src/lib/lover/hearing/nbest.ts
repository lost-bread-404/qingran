export type HearingAlternative = {
  span: string;
  candidates: string[];
};

export function applyAltTags(text: string, alts: HearingAlternative[]): string {
  let used = text;
  for (const alt of alts) {
    const tag = `{${alt.candidates[0]}|${alt.candidates[1]}}`;
    if (used.includes(alt.span)) {
      used = used.replace(alt.span, tag);
    } else {
      used += tag;
    }
  }
  return used;
}

export const NBEST_INSTRUCTION = `
不确定时才填 alternatives。绝大多数情况必须是空数组 []。
每个 span 最多 2 个候选，整句最多 2 个 span。候选按更可能的在前。
{
  "alternatives": [{ "span": "原文片段", "candidates": ["A", "B"] }]
}`;
