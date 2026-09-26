# 费用记账

清然只记账，不在 app 里设花费上限：Rosie 每月在 xAI 预付约 $100，预付额度就是硬上限（见 requirements 第 0 节）。主动消息另有每天的软上限（`REACH_LLM_DAY_MAX` / `REACH_SENT_DAY_MAX`）。

## 价格表与实际金额

来源：https://docs.x.ai/developers/models 与 Voice API 定价，`PRICES_CHECKED_AT` 在 `src/lib/lover/brain/config.ts`。

- 文本：`MODEL_PRICES` 每 1M tokens 的 input / cached / output。prompt ≥ 20 万 tokens 时整单翻倍。
- reasoning tokens **不包含在** `output_tokens` / `completion_tokens` 里，按输出价另计。
- TTS：$15 / 1M 字符；STT REST $0.10 / 小时，streaming $0.20 / 小时。

Responses / Chat Completions 会返回 `usage.cost_in_usd_ticks`。换算：**1 USD = 10^10 ticks**（`usd = ticks / 10_000_000_000`）。Streaming 最后一块带 usage（`stream_options.include_usage`）。

TTS / STT **不返回** ticks，按价格表入账（`cost_source = price_table`）。

入账优先级：

| 情况 | `usd` | `usd_est` | `cost_source` |
|---|---|---|---|
| 有 `cost_in_usd_ticks` | 实际金额 | 价格表估算 | `xai` |
| 有 token usage、无 ticks | 价格表估算 | 同左 | `price_table` |
| usage 缺失 | 字符估算 | 同左 | `char_estimate` |

费用页显示本月 `cost_source=xai` 的占比，以及按 route 的 `usd` 与 `usd_est` 偏差；超过 10% 标红并提示检查 `MODEL_PRICES`。对账区块旁有「xAI 实际金额合计」。

**没有**用普通 `XAI_API_KEY` 就能拉账户账单的公开 API。Management API 的 `/v1/billing/teams/{team_id}/usage` 需要 team id 和管理凭证，所以对账保持手动。

## `store: false`

所有 Responses 请求默认 `store: false`（`QR_XAI_STORE`，只有设为 `true` 才打开）。本项目每轮自行发送完整上下文，不用 `previous_response_id`。

上线后对比开启前后 reflect 的缓存命中率。如果命中率明显下降，把默认改回 `true`，并在这里记下结论。

## 月度汇总

`spend_monthly(month, route, model, usd, calls, tokens_in, tokens_cached, tokens_out)` 在每次 `recordSpend` 时累加；90 天删除 `spend_events` 明细前会补写缺失的月度行。`spend_daily` 仍按日保留。`spend_rate` 只留 24 小时。

## 对账与导出

- 导出：费用页「导出本月 CSV」
- 对账：输入 xAI 控制台该月实际金额
- 一年前的明细可以手动归档（按日汇总仍在 `spend_daily`）

