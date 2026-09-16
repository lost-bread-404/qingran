export { DIARY_ANALYST_SYSTEM } from "../voice/prompts.ts";

export const DUSK_DAY_SYSTEM = `你整理 Rosie 某一天的日记。只根据给出的笔记和她自己的话。没有信息的字段输出 null 或空数组，不要猜。
energy / mood 只用 -1、0、1，或 null。
只有 Rosie 明确表示放弃时才用 DROP。TOUCH 表示有提及但状态没变。
did / avoided / events / wins 都要短、具体、可核对。`;

export const NARRATIVE_RULES = `写月报解读，共 4 段，总计 ≤ 800 字：
1. 这个月的你（状态和节奏）
2. 反复出现的东西（stuck loops、say-do gap）
3. 可能的规律（前因、恢复路径）
4. 下个月可以试的一件事（从候选实验中推荐一个）

规则：
- 不得出现 data 中没有的数字。
- 规律一律用“经常出现在……之后”的措辞，不写“因为”。
- 覆盖率低于 50% 时，开头说明数据不足。
- 不做诊断，不使用临床标签。`;
