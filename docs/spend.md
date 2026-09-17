# 费用限额

清然自己记账、自己停。xAI 开了自动续费之后，不能靠账户余额用完才停。

## 价格表

来源：https://docs.x.ai/developers/models 与 Voice API 定价，`PRICES_CHECKED_AT` 在 `src/lib/lover/brain/config.ts`。

- 文本：`MODEL_PRICES` 每 1M tokens 的 input / cached / output。prompt ≥ 20 万 tokens 时整单翻倍（本项目的 prompt 远小于这个阈值）。
- reasoning tokens **不包含在** `output_tokens` / `completion_tokens` 里，按输出价另计。
- TTS：$15 / 1M 字符；STT REST $0.10 / 小时，streaming $0.20 / 小时。

核对方法：改模型时同时改 `MODEL_CLASSES`、`MODEL_CAPS`、`MODEL_PRICES`，对照 xAI 文档。有 `usage` 时按 token 计；缺失时按字符估算（汉字 ≈ 1 token，其他 4 字符 ≈ 1 token），`estimated=true`。

xAI Responses / Chat Completions 会返回 `usage.cost_in_usd_ticks`（实际账单）。目前仍用价格表估算，方便和明细对上。对账差异超过 10% 时先核对价格表。

**没有**用普通 `XAI_API_KEY` 就能拉账户账单的公开 API。Management API 的 `/v1/billing/teams/{team_id}/usage` 需要 team id 和管理凭证，所以对账保持手动：Diary → 费用 → 输入控制台看到的实际金额。

## 限额档位

默认（可用环境变量 `QR_SPEND_DAY_SOFT/HARD/BREAKER`、`QR_SPEND_MONTH_*` 覆盖，设置页可改）：

| | 软 | 硬 | 熔断 |
|---|---|---|---|
| 日 | $15 | $30 | $50 |
| 月 | $100 | $150 | $200 |

- 软：暂停 P3（synth / backfill / report / judge）
- 硬：再暂停 P2（archive / dusk / portrait / assign / ask）
- 熔断：连 Voice / TTS / STT / Reflector 也停

被暂停的后台任务保持 `pending`，不增加 `attempts`，`run_after` 到次日 04:30（或下月 1 日 04:30）。

## 熔断后怎么恢复

设置页或 Diary「费用」：熔断时出现「今天继续使用 / 本月继续使用」，再输入一次 `APP_PASSWORD`。只解除熔断，软 / 硬上限仍在。周期过了 override 自动失效。

## 对账与导出

- 导出：费用页「导出本月 CSV」
- 对账：输入 xAI 控制台该月实际金额
- 一年前的明细可以手动归档（按日汇总仍在 `spend_daily`）

建议在 xAI 控制台再设一层月度消费上限（例如 $250），作为应用限额外面的兜底。
